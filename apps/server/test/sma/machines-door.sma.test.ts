import { authApiKeys, getHost, listHosts } from "@bb/db";
import { hostDaemonEnrollResponseSchema } from "@bb/host-daemon-contract";
import { createHostJoinCodeResponseSchema } from "@bb/server-contract";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createMachineAuthService } from "../../src/services/machine-auth.js";
import { issueHostEnrollKey } from "../../src/services/hosts/host-enrollment.js";
import { createMigratedConnection } from "@bb/db/testing";
import { makeTempDir } from "@bb/test-helpers";
import { readJson } from "../helpers/json.js";
import {
  seedHost,
  seedPrimaryHost,
  seedSession,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1";
const ENROLL_KEY_TTL_MS = 15 * 60 * 1000;
const noopLogger = {
  debug(): void {},
  error(): void {},
  info(): void {},
  warn(): void {},
};

async function enrollRequest(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response },
  token: string,
  body: { hostId: string; hostName: string },
): Promise<Response> {
  return Promise.resolve(
    app.request("/internal/hosts/enroll", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

async function createAuthService() {
  const db = createMigratedConnection();
  const machineAuth = await createMachineAuthService({
    dataDir: await makeTempDir(),
    db,
    logger: noopLogger,
  });
  await machineAuth.ensureReady();
  return { db, machineAuth };
}

describe("machines and one household (core)", () => {
  it("[sma:m_mc_pair] the invitation is minted on the hub only, as a one-shot code with a fifteen-minute term, and writes no machine row", async () => {
    await withTestHarness(async (harness) => {
      const before = Date.now();
      const issued = await issueHostEnrollKey(harness.deps, {
        enrollSource: "public-multi-machine",
        hostId: "host_invited",
      });
      expect(issued.hostId).toBe("host_invited");
      expect(issued.enrollKey.key).toMatch(/^bbde_/u);
      expect(issued.enrollKey.expiresAt).toBeGreaterThanOrEqual(
        before + ENROLL_KEY_TTL_MS - 5_000,
      );
      expect(issued.enrollKey.expiresAt).toBeLessThanOrEqual(
        Date.now() + ENROLL_KEY_TTL_MS + 5_000,
      );
      const stored = harness.db
        .select()
        .from(authApiKeys)
        .where(eq(authApiKeys.configId, "daemon-enroll"))
        .all();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.remaining).toBe(1);
      expect(stored[0]?.metadata).toContain("host_invited");
      // no network action and no peer yet: the machine register is untouched
      expect(getHost(harness.db, "host_invited")).toBeNull();

      // a machine credential cannot mint an invitation (hub only)
      const refused = await harness.app.request(`${API}/hosts/join-codes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bb-gate-auth": "machine",
        },
        body: JSON.stringify({}),
      });
      expect(refused.status).toBe(403);
      expect(await readJson(refused)).toMatchObject({
        code: "machine_host_management_forbidden",
      });
      expect(
        harness.db
          .select()
          .from(authApiKeys)
          .where(eq(authApiKeys.configId, "daemon-enroll"))
          .all(),
      ).toHaveLength(1);

      const viaRoute = await harness.app.request(`${API}/hosts/join-codes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(viaRoute.status).toBe(201);
      const body = createHostJoinCodeResponseSchema.parse(
        await readJson(viaRoute),
      );
      expect(body.joinCode).toMatch(/^bbde_/u);
      expect(getHost(harness.db, body.hostId)).toBeNull();
    });
  });

  it("[sma:m_mc_pair_book] the invitation book holds one-shot codes for fifteen minutes: a code works once, only for its own machine, and not after its term", async () => {
    await withTestHarness(async (harness) => {
      const mint = async (hostId: string) => {
        const key = await harness.deps.machineAuth.issueHostEnrollKey({
          enrollSource: "loopback",
          hostId,
        });
        return { enrollKey: key.key, expiresAt: key.expiresAt };
      };
      const first = await mint("host_book_once");
      expect(first.expiresAt - Date.now()).toBeLessThanOrEqual(
        ENROLL_KEY_TTL_MS + 5_000,
      );
      expect(first.expiresAt - Date.now()).toBeGreaterThan(
        ENROLL_KEY_TTL_MS - 60_000,
      );

      expect(
        (
          await enrollRequest(harness.app, first.enrollKey, {
            hostId: "host_book_once",
            hostName: "Once",
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await enrollRequest(harness.app, first.enrollKey, {
            hostId: "host_book_once",
            hostName: "Once",
          })
        ).status,
      ).toBe(401);

      const wrongMachine = await mint("host_book_owner");
      expect(
        (
          await enrollRequest(harness.app, wrongMachine.enrollKey, {
            hostId: "host_book_thief",
            hostName: "Thief",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await enrollRequest(harness.app, "bbde_not-a-real-code", {
            hostId: "host_book_owner",
            hostName: "Guess",
          })
        ).status,
      ).toBe(401);

      const lapsed = await mint("host_book_lapsed");
      harness.db
        .update(authApiKeys)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(authApiKeys.configId, "daemon-enroll"))
        .run();
      expect(
        (
          await enrollRequest(harness.app, lapsed.enrollKey, {
            hostId: "host_book_lapsed",
            hostName: "Late",
          })
        ).status,
      ).toBe(401);
    });
  });

  it("[sma:m_mc_join] a joining machine spends the code, the address is checked before any key is written, and the peer is registered at once", async () => {
    const { db, machineAuth } = await createAuthService();
    const code = await machineAuth.issueHostEnrollKey({
      enrollSource: "public-multi-machine",
      hostId: "host_joiner",
    });

    // the address (host id) is checked before the write: nothing is minted
    await expect(
      machineAuth.enrollHost({ hostId: "host_other", token: code.key }),
    ).resolves.toBeNull();
    expect(
      db
        .select()
        .from(authApiKeys)
        .where(eq(authApiKeys.configId, "daemon-host"))
        .all(),
    ).toHaveLength(0);

    const second = await machineAuth.issueHostEnrollKey({
      enrollSource: "public-multi-machine",
      hostId: "host_joiner",
    });
    const enrolled = await machineAuth.enrollHost({
      hostId: "host_joiner",
      token: second.key,
    });
    expect(enrolled?.metadata).toEqual({ hostId: "host_joiner" });
    expect(enrolled?.hostKey).toMatch(/^bbdh_/u);
    // the new key is live at once, bound to this machine
    await expect(
      machineAuth.verifyDaemonHostKey(enrolled?.hostKey ?? ""),
    ).resolves.toMatchObject({ metadata: { hostId: "host_joiner" } });
    // the code is spent
    await expect(
      machineAuth.enrollHost({ hostId: "host_joiner", token: second.key }),
    ).resolves.toBeNull();
    expect(
      db
        .select()
        .from(authApiKeys)
        .where(eq(authApiKeys.configId, "daemon-host"))
        .all(),
    ).toHaveLength(1);

    // and through the door, the peer is in the register the moment it joins
    await withTestHarness(async (harness) => {
      expect(listHosts(harness.db).some((h) => h.id === "host_door")).toBe(
        false,
      );
      const key = await harness.deps.machineAuth.issueHostEnrollKey({
        enrollSource: "public-multi-machine",
        hostId: "host_door",
      });
      const response = await enrollRequest(harness.app, key.key, {
        hostId: "host_door",
        hostName: "Door Machine",
      });
      expect(response.status).toBe(201);
      expect(
        hostDaemonEnrollResponseSchema.parse(await readJson(response)).hostId,
      ).toBe("host_door");
      expect(getHost(harness.db, "host_door")?.name).toBe("Door Machine");
    });
  });

  it("[sma:m_mc_peer_write] the register gets the peer only through the enroll door, with the name the machine gave, and a refused enrollment writes nothing", async () => {
    await withTestHarness(async (harness) => {
      const key = await harness.deps.machineAuth.issueHostEnrollKey({
        enrollSource: "loopback",
        hostId: "host_peer",
      });
      expect(getHost(harness.db, "host_peer")).toBeNull();

      const refused = await enrollRequest(harness.app, key.key, {
        hostId: "host_not_peer",
        hostName: "Impostor",
      });
      expect(refused.status).toBe(401);
      expect(listHosts(harness.db).map((host) => host.id)).not.toContain(
        "host_not_peer",
      );
      expect(getHost(harness.db, "host_peer")).toBeNull();

      const fresh = await harness.deps.machineAuth.issueHostEnrollKey({
        enrollSource: "loopback",
        hostId: "host_peer",
      });
      const accepted = await enrollRequest(harness.app, fresh.key, {
        hostId: "host_peer",
        hostName: "Peer Name From The Machine",
      });
      expect(accepted.status).toBe(201);
      expect(getHost(harness.db, "host_peer")).toMatchObject({
        id: "host_peer",
        name: "Peer Name From The Machine",
      });
    });
  });

  it("[sma:m_mc_remove] letting a machine go moves the settings and the live register together: row tombstoned, credentials revoked, live session closed", async () => {
    await withTestHarness(async (harness) => {
      const primary = seedHost(harness.deps, { id: "host_primary" });
      seedPrimaryHost(harness.deps, primary.id);
      const host = seedHost(harness.deps, { id: "host_leaving" });
      const session = seedSession(harness.deps, host.id);
      const socket = { close: vi.fn(), send: vi.fn() };
      harness.hub.registerDaemon(session.id, host.id, socket);
      const hostKey = await harness.deps.machineAuth.issueDaemonHostKey({
        hostId: host.id,
      });
      expect(harness.hub.hasDaemonForHost(host.id)).toBe(true);
      await expect(
        harness.deps.machineAuth.verifyDaemonHostKey(hostKey),
      ).resolves.not.toBeNull();

      const response = await harness.app.request(`${API}/hosts/${host.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });

      expect(getHost(harness.db, host.id)?.destroyedAt).not.toBeNull();
      await expect(
        harness.deps.machineAuth.verifyDaemonHostKey(hostKey),
      ).resolves.toBeNull();
      expect(harness.hub.hasDaemonForHost(host.id)).toBe(false);
      expect(socket.close).toHaveBeenCalledWith(1000, "expired");

      // the server's own machine is never let go
      const own = await harness.app.request(`${API}/hosts/${primary.id}`, {
        method: "DELETE",
      });
      expect(own.status).toBe(400);
      expect(await readJson(own)).toMatchObject({
        code: "primary_host_removal_refused",
      });
      expect(getHost(harness.db, primary.id)?.destroyedAt).toBeNull();
    });
  });

  it("[sma:m_gt_401] every refusal at the internal door is the same 401 body: no reason, no route", async () => {
    await withTestHarness(async (harness) => {
      const known = await harness.deps.machineAuth.issueHostEnrollKey({
        enrollSource: "loopback",
        hostId: "host_gate",
      });
      const attempts: Array<{ path: string; headers: Record<string, string> }> = [
        { path: "/internal/session/open", headers: {} },
        { path: "/internal/session/open", headers: { authorization: "Basic abc" } },
        { path: "/internal/session/open", headers: { authorization: "Bearer " } },
        {
          path: "/internal/session/open",
          headers: { authorization: "Bearer bbdh_not-a-key" },
        },
        // an enroll code is not a host key
        {
          path: "/internal/session/open",
          headers: { authorization: `Bearer ${known.key}` },
        },
        // a route that does not exist answers the same as one that does
        { path: "/internal/no-such-route", headers: {} },
        { path: "/internal/no-such-route/", headers: {} },
      ];
      const seen = new Set<string>();
      for (const attempt of attempts) {
        const response = await harness.app.request(attempt.path, {
          method: "POST",
          headers: attempt.headers,
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toBe("application/json");
        seen.add(await response.text());
      }
      expect([...seen]).toEqual([
        JSON.stringify({ code: "unauthorized", message: "Unauthorized" }),
      ]);
    });
  });
});
