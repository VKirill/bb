import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addVkOwnerKey,
  createVkOwnerTicket,
  generateVkOwnerKeyPair,
  revokeVkOwnerKeys,
  VK_OWNER_COOKIE,
  VK_OWNER_SESSION_MS,
} from "@bb/config/vk-owner-auth";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mintVkOwnerSessionCookie,
  registerVkOwnerRoutes,
  verifyVkOwnerProof,
  verifyVkOwnerSessionCookie,
} from "../../src/services/plugins/vk-owner-auth.js";
import { createServerErrorHandler } from "../../src/errors.js";
import type { ServerLogger } from "../../src/types.js";

const noopLogger = {
  debug(): void {},
  error(): void {},
  info(): void {},
  warn(): void {},
} as unknown as ServerLogger;

let dataDir = "";
let savedFlag: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sma-vk-owner-"));
  savedFlag = process.env.BB_VK_OWNER_AUTH;
  process.env.BB_VK_OWNER_AUTH = "1";
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.BB_VK_OWNER_AUTH;
  else process.env.BB_VK_OWNER_AUTH = savedFlag;
});

function pairedOwner() {
  const pair = generateVkOwnerKeyPair();
  addVkOwnerKey(dataDir, { publicKey: pair.publicKey, label: "mac" });
  return pair;
}

function appWithRoutes(): Hono {
  const app = new Hono();
  app.onError(createServerErrorHandler(noopLogger));
  registerVkOwnerRoutes(app, { config: { dataDir }, logger: noopLogger });
  return app;
}

function cookieValue(setCookie: string | null): string {
  const first = (setCookie ?? "").split(";")[0] ?? "";
  expect(first.startsWith(`${VK_OWNER_COOKIE}=`)).toBe(true);
  return first.slice(VK_OWNER_COOKIE.length + 1);
}

describe("owner login window (core: vk-owner-auth)", () => {
  it("[sma:m_gt_bootstrap] a signed ticket in the URL is traded once for the session cookie and the browser is sent to the app", async () => {
    const pair = pairedOwner();
    const app = appWithRoutes();
    const ticket = createVkOwnerTicket({ privateKey: pair.privateKey, keyId: pair.keyId });

    const bad = await app.request("/vk/owner/session?ticket=v1.garbage");
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ code: "vk_ticket_refused" });
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await app.request(`/vk/owner/session?ticket=${encodeURIComponent(ticket)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${Math.floor(VK_OWNER_SESSION_MS / 1000)}`);
    // the cookie it sets is a live session of the paired key
    expect(verifyVkOwnerSessionCookie(dataDir, cookieValue(setCookie))).toBe(pair.keyId);
  });

  it("[sma:k_v_open] the login link works once: the second use of the same ticket is refused and sets no cookie", async () => {
    const pair = pairedOwner();
    const app = appWithRoutes();
    const ticket = createVkOwnerTicket({ privateKey: pair.privateKey, keyId: pair.keyId });
    const url = `/vk/owner/session?ticket=${encodeURIComponent(ticket)}`;

    const first = await app.request(url);
    expect(first.status).toBe(302);
    expect(first.headers.get("set-cookie")).toContain(`${VK_OWNER_COOKIE}=vko1.`);

    const second = await app.request(url);
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ code: "vk_ticket_refused" });
    expect(second.headers.get("set-cookie")).toBeNull();

    // a ticket signed by a key the hub does not know trades for nothing either
    const stranger = generateVkOwnerKeyPair();
    const foreign = createVkOwnerTicket({ privateKey: stranger.privateKey, keyId: stranger.keyId });
    const refused = await app.request(`/vk/owner/session?ticket=${encodeURIComponent(foreign)}`);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("set-cookie")).toBeNull();
  });

  it("[sma:k_lib_window] a query string is never a credential, except the one ticket exchange", async () => {
    const pair = pairedOwner();
    const app = appWithRoutes();
    const ticket = createVkOwnerTicket({ privateKey: pair.privateKey, keyId: pair.keyId });
    const minted = mintVkOwnerSessionCookie(dataDir, pair.keyId);

    // the status door answers with the caller's identity: a ticket or a cookie value in its query is nobody
    const viaTicket = await app.request(`/vk/owner/status?ticket=${encodeURIComponent(ticket)}`);
    expect(await viaTicket.json()).toMatchObject({ enabled: true, paired: true, owner: false });
    expect(viaTicket.headers.get("set-cookie")).toBeNull();
    const viaCookieQuery = await app.request(
      `/vk/owner/status?${VK_OWNER_COOKIE}=${encodeURIComponent(minted.value)}`,
      { headers: { "sec-fetch-site": "same-origin" } },
    );
    expect(await viaCookieQuery.json()).toMatchObject({ owner: false });
    // the same value in the Cookie header is accepted: the header, not the query, carries the credential
    const viaHeader = await app.request("/vk/owner/status", {
      headers: {
        cookie: `${VK_OWNER_COOKIE}=${minted.value}`,
        "sec-fetch-site": "same-origin",
      },
    });
    expect(await viaHeader.json()).toMatchObject({ owner: true });

    // proof of the owner for any other request ignores the query too
    const proof = await verifyVkOwnerProof({
      dataDir,
      method: "POST",
      target: `/api/v1/plugins/install?ticket=${encodeURIComponent(ticket)}&${VK_OWNER_COOKIE}=${encodeURIComponent(minted.value)}`,
      header: (name) =>
        ({ origin: "http://hub", "sec-fetch-site": "same-origin" } as Record<string, string>)[
          name.toLowerCase()
        ],
      readBody: async () => new Uint8Array(),
    });
    expect(proof).toBeNull();

    // the one exchange: the ticket on the session door
    const exchange = await app.request(`/vk/owner/session?ticket=${encodeURIComponent(ticket)}`);
    expect(exchange.status).toBe(302);
    expect(exchange.headers.get("set-cookie")).toContain(`${VK_OWNER_COOKIE}=vko1.`);
  });

  it("[sma:m_gt_accept_cookie] the session cookie is signed with the hub key, bound to the paired key and the epoch, and expires after ninety days", () => {
    const pair = pairedOwner();
    const now = 1_800_000_000_000;
    const minted = mintVkOwnerSessionCookie(dataDir, pair.keyId, now);
    expect(minted.maxAgeSeconds).toBe(90 * 24 * 60 * 60);
    const parts = minted.value.split(".");
    expect(parts).toHaveLength(5);
    expect(parts.slice(0, 2)).toEqual(["vko1", pair.keyId]);
    expect(Number(parts[3])).toBe(now + VK_OWNER_SESSION_MS);

    expect(verifyVkOwnerSessionCookie(dataDir, minted.value, now + 1)).toBe(pair.keyId);
    expect(verifyVkOwnerSessionCookie(dataDir, minted.value, now + VK_OWNER_SESSION_MS - 1)).toBe(pair.keyId);
    expect(verifyVkOwnerSessionCookie(dataDir, minted.value, now + VK_OWNER_SESSION_MS)).toBeNull();

    // a later expiry written into the cookie breaks the signature
    const stretched = [...parts];
    stretched[3] = String(Number(parts[3]) + 1);
    expect(verifyVkOwnerSessionCookie(dataDir, stretched.join("."), now + 1)).toBeNull();

    // revoking the keys bumps the epoch and ends every session
    revokeVkOwnerKeys(dataDir);
    expect(verifyVkOwnerSessionCookie(dataDir, minted.value, now + 1)).toBeNull();
  });

  it("[sma:m_gt_accept_cookie] a session cookie signs the owner's decision only from the browser app (Origin and fetch metadata)", async () => {
    const pair = pairedOwner();
    const minted = mintVkOwnerSessionCookie(dataDir, pair.keyId);
    const ask = (extra: Record<string, string>) =>
      verifyVkOwnerProof({
        dataDir,
        method: "POST",
        target: "/api/v1/threads/t1/interactions/i1/respond",
        header: (name) =>
          ({ cookie: `${VK_OWNER_COOKIE}=${minted.value}`, ...extra } as Record<string, string>)[
            name.toLowerCase()
          ],
        readBody: async () => new Uint8Array(),
      });
    expect(await ask({ origin: "http://hub", "sec-fetch-site": "same-origin" })).toEqual({
      kind: "owner-ui",
      evidence: "owner-session",
    });
    expect(await ask({ "sec-fetch-site": "same-origin" })).toBeNull();
    expect(await ask({ origin: "http://hub", "sec-fetch-site": "cross-site" })).toBeNull();
    // an agent's thread token rules the cookie out
    expect(
      await ask({
        origin: "http://hub",
        "sec-fetch-site": "same-origin",
        "x-bb-vk-thread-token": "anything",
      }),
    ).toBeNull();
  });

  it("[sma:m_gt_authed] a forged or missing credential admits nobody; a hub with no paired key admits nobody", () => {
    const pair = pairedOwner();
    const now = 1_800_000_000_000;
    const minted = mintVkOwnerSessionCookie(dataDir, pair.keyId, now);
    expect(verifyVkOwnerSessionCookie(dataDir, minted.value, now)).toBe(pair.keyId);
    expect(verifyVkOwnerSessionCookie(dataDir, undefined, now)).toBeNull();
    expect(verifyVkOwnerSessionCookie(dataDir, "", now)).toBeNull();

    const parts = minted.value.split(".");
    const signature = parts[4] as string;
    // same length, one character different
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(verifyVkOwnerSessionCookie(dataDir, [...parts.slice(0, 4), flipped].join("."), now)).toBeNull();
    // shorter and longer signatures are refused without an error
    expect(verifyVkOwnerSessionCookie(dataDir, [...parts.slice(0, 4), signature.slice(1)].join("."), now)).toBeNull();
    expect(verifyVkOwnerSessionCookie(dataDir, [...parts.slice(0, 4), `${signature}x`].join("."), now)).toBeNull();
    expect(verifyVkOwnerSessionCookie(dataDir, [...parts.slice(0, 4), ""].join("."), now)).toBeNull();

    // a validly signed cookie for a key that is not (or no longer) on the hub admits nobody
    const orphan = mintVkOwnerSessionCookie(dataDir, "k_not_paired", now);
    expect(verifyVkOwnerSessionCookie(dataDir, orphan.value, now)).toBeNull();
  });
});
