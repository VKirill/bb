import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addVkOwnerKey,
  createVkOwnerTicket,
  generateVkOwnerKeyPair,
  VK_OWNER_COOKIE,
} from "@bb/config/vk-owner-auth";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerErrorHandler } from "../../errors.js";
import type { ServerLogger } from "../../types.js";
import { registerVkOwnerRoutes, verifyVkOwnerSessionCookie } from "./vk-owner-auth.js";

// SMA map, region 5 «Daemon boot», n469 «Window entry link» (m_entry_link): «The address and token exchange go to the
// person's console, never into a log file.» In BB the link is printed by `bb owner login --print` (apps/cli, its own
// [sma:m_entry_link] test); here the hub's half: the ticket in that link is traded once for the session cookie, and
// nothing the server logs during the exchange carries the ticket or the cookie.

function recordingLogger(): { logger: ServerLogger; lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(`${level} ${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}`);
  };
  return {
    logger: { debug: record("debug"), error: record("error"), info: record("info"), warn: record("warn") } as unknown as ServerLogger,
    lines,
  };
}

let dataDir = "";
let savedFlag: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "sma-entry-link-"));
  savedFlag = process.env.BB_VK_OWNER_AUTH;
  process.env.BB_VK_OWNER_AUTH = "1";
});

afterEach(async () => {
  if (savedFlag === undefined) delete process.env.BB_VK_OWNER_AUTH;
  else process.env.BB_VK_OWNER_AUTH = savedFlag;
  await rm(dataDir, { recursive: true, force: true });
});

describe("the window entry link (core: vk-owner-auth registerVkOwnerRoutes)", () => {
  it("[sma:m_entry_link] the link's one-time ticket is traded once for the session cookie, and neither the ticket nor the cookie reaches the server log", async () => {
    const pair = generateVkOwnerKeyPair();
    addVkOwnerKey(dataDir, { publicKey: pair.publicKey, label: "mac" });
    const stranger = generateVkOwnerKeyPair();
    const { logger, lines } = recordingLogger();
    const app = new Hono();
    app.onError(createServerErrorHandler(logger));
    registerVkOwnerRoutes(app, { config: { dataDir }, logger });

    const ticket = createVkOwnerTicket({ privateKey: pair.privateKey, keyId: pair.keyId });
    const forged = createVkOwnerTicket({ privateKey: stranger.privateKey, keyId: pair.keyId });
    const trade = (value: string) => app.request(`/vk/owner/session?ticket=${encodeURIComponent(value)}`);

    const first = await trade(ticket);
    expect(first.status).toBe(302);
    const setCookie = first.headers.get("set-cookie") ?? "";
    const cookie = (setCookie.split(";")[0] ?? "").slice(VK_OWNER_COOKIE.length + 1);
    expect(setCookie.startsWith(`${VK_OWNER_COOKIE}=`)).toBe(true);
    expect(verifyVkOwnerSessionCookie(dataDir, cookie)).toBe(pair.keyId);

    // Once: the same link again, or a ticket signed by another key, gets no cookie.
    const again = await trade(ticket);
    expect({ status: again.status, cookie: again.headers.get("set-cookie") }).toEqual({ status: 403, cookie: null });
    expect(await again.json()).toMatchObject({ code: "vk_ticket_refused" });
    const wrongKey = await trade(forged);
    expect({ status: wrongKey.status, cookie: wrongKey.headers.get("set-cookie") }).toEqual({ status: 403, cookie: null });

    // Nothing the server logged during the three requests carries a credential.
    const secrets = [ticket, encodeURIComponent(ticket), forged, cookie];
    expect(lines.filter((line) => secrets.some((secret) => line.includes(secret)))).toEqual([]);
  });
});
