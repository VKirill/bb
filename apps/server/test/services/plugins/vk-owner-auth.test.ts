import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addVkOwnerKey,
  consumeVkOwnerPairingCode,
  createVkOwnerPairingCode,
  createVkOwnerTicket,
  generateVkOwnerKeyPair,
  isVkOwnerEnforced,
  parseVkOwnerSignature,
  parseVkOwnerTicket,
  readVkOwnerState,
  removeVkOwnerKey,
  revokeVkOwnerKeys,
  signVkOwnerRequest,
  VK_OWNER_ENFORCE_GRACE_MS,
  VK_OWNER_SIG_HEADER,
  verifyVkOwnerRequestSignature,
  verifyVkOwnerTicketSignature,
} from "@bb/config/vk-owner-auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedThreadFixture, seedThread } from "../../helpers/seed.js";
import {
  isVkOwnerGatedRoute,
} from "../../../src/services/plugins/vk-owner-auth.js";
import {
  classifyVkRpcCaller,
  createVkThreadToken,
  VK_CLIENT_HEADER,
  VK_THREAD_TOKEN_HEADER,
} from "../../../src/services/plugins/vk-rpc-caller.js";
import {
  createTestAppHarness,
  startTestServer,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";
const API = "/api/v1";

function headers(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()];
}

describe("VK owner login: primitives", () => {
  it("signs a request over method, target, body and a fresh nonce", () => {
    const pair = generateVkOwnerKeyPair();
    const body = new TextEncoder().encode('{"a":1}');
    const value = signVkOwnerRequest({
      privateKey: pair.privateKey,
      keyId: pair.keyId,
      method: "POST",
      target: "/api/v1/plugins/install",
      body,
    });
    const parsed = parseVkOwnerSignature(value)!;
    const check = (over: Partial<Parameters<typeof verifyVkOwnerRequestSignature>[0]> = {}) =>
      verifyVkOwnerRequestSignature({
        publicKey: pair.publicKey,
        parsed,
        method: "POST",
        target: "/api/v1/plugins/install",
        body,
        ...over,
      });
    expect(check()).toBe(true);
    expect(check({ body: new TextEncoder().encode('{"a":2}') })).toBe(false);
    expect(check({ target: "/api/v1/plugins/other" })).toBe(false);
    expect(check({ method: "PUT" })).toBe(false);
    expect(check({ now: Date.now() + 5 * 60_000 })).toBe(false);
    expect(check({ publicKey: generateVkOwnerKeyPair().publicKey })).toBe(false);
    expect(parseVkOwnerSignature("v1.nothex.1.abc.def")).toBeNull();
    expect(parseVkOwnerSignature(undefined)).toBeNull();
  });

  it("a request signature is not a login ticket and the other way round", () => {
    const pair = generateVkOwnerKeyPair();
    const ticket = createVkOwnerTicket({ privateKey: pair.privateKey, keyId: pair.keyId });
    expect(
      verifyVkOwnerTicketSignature({ publicKey: pair.publicKey, parsed: parseVkOwnerTicket(ticket)! }),
    ).toBe(true);
    expect(parseVkOwnerSignature(ticket)).toBeNull();
    const sig = signVkOwnerRequest({
      privateKey: pair.privateKey,
      keyId: pair.keyId,
      method: "GET",
      target: "/",
    });
    expect(parseVkOwnerTicket(sig)).toBeNull();
  });

  it("pairing code: single use, five tries, expires; the hub keeps a hash only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vk-owner-pair-"));
    const { code } = createVkOwnerPairingCode(dir, 1_000);
    const stored = JSON.stringify(
      JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "vk-owner-pairing.json"), "utf8")),
    );
    expect(stored).not.toContain(code.replace("-", ""));
    expect(consumeVkOwnerPairingCode(dir, "WRONG-CODE", 2_000)).toBe("invalid");
    expect(consumeVkOwnerPairingCode(dir, code.toLowerCase(), 3_000)).toBe("ok");
    expect(consumeVkOwnerPairingCode(dir, code, 4_000)).toBe("none");

    const again = createVkOwnerPairingCode(dir, 1_000);
    for (let i = 0; i < 4; i++) consumeVkOwnerPairingCode(dir, "AAAAA-AAAAA", 2_000);
    expect(consumeVkOwnerPairingCode(dir, "AAAAA-AAAAA", 2_000)).toBe("locked");
    expect(consumeVkOwnerPairingCode(dir, again.code, 2_500)).toBe("none");

    const late = createVkOwnerPairingCode(dir, 1_000);
    expect(consumeVkOwnerPairingCode(dir, late.code, 1_000 + 11 * 60_000)).toBe("expired");
  });

  it("enforcement starts only after the first pairing plus the grace, and survives a revoke", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vk-owner-grace-"));
    const env = { BB_VK_OWNER_AUTH: "1" };
    const now = 10_000_000;
    expect(isVkOwnerEnforced(dir, env, now)).toBe(false); // flag on, nothing paired
    const pair = generateVkOwnerKeyPair();
    addVkOwnerKey(dir, { publicKey: pair.publicKey, label: "mac", now });
    expect(isVkOwnerEnforced(dir, env, now + 1)).toBe(false); // inside the grace
    expect(isVkOwnerEnforced(dir, env, now + VK_OWNER_ENFORCE_GRACE_MS)).toBe(true);
    expect(isVkOwnerEnforced(dir, {}, now + VK_OWNER_ENFORCE_GRACE_MS)).toBe(false); // flag off
    const state = readVkOwnerState(dir);
    revokeVkOwnerKeys(dir);
    const after = readVkOwnerState(dir);
    expect(after.keys).toEqual([]);
    expect(after.epoch).toBe(state.epoch + 1);
    expect(isVkOwnerEnforced(dir, env, now + VK_OWNER_ENFORCE_GRACE_MS)).toBe(true);
    addVkOwnerKey(dir, { publicKey: pair.publicKey, label: "mac", now });
    expect(removeVkOwnerKey(dir, pair.keyId)).toBe(true);
    expect(removeVkOwnerKey(dir, pair.keyId)).toBe(false);
  });
});

describe("VK owner login: classification", () => {
  const base = { pluginCaller: { kind: "client" } as const, browserGuardPassed: true };

  it("login off: the forged CLI header of the audit is unverified-owner, never owner-cli; the app keeps owner-ui (claim)", () => {
    expect(classifyVkRpcCaller({ ...base, header: headers({ [VK_CLIENT_HEADER]: "cli" }) })).toEqual({
      kind: "unverified-owner",
      evidence: "cli-header",
    });
    expect(
      classifyVkRpcCaller({ ...base, header: headers({ origin: BASE, "sec-fetch-site": "same-origin" }) }),
    ).toEqual({ kind: "owner-ui", evidence: "browser-headers" });
    // An agent's marks always win over browser marks.
    expect(
      classifyVkRpcCaller({
        ...base,
        header: headers({ origin: BASE, "sec-fetch-site": "same-origin", [VK_THREAD_TOKEN_HEADER]: "vkt1.x.y" }),
      }).kind,
    ).toBe("unknown");
  });

  it("login enforced: marks alone are unknown; only a verified proof is owner-*", () => {
    const ownerAuth = { enforced: true, proof: null };
    expect(
      classifyVkRpcCaller({ ...base, ownerAuth, header: headers({ [VK_CLIENT_HEADER]: "cli" }) }).kind,
    ).toBe("unknown");
    expect(
      classifyVkRpcCaller({
        ...base,
        ownerAuth,
        header: headers({ origin: BASE, "sec-fetch-site": "same-origin" }),
      }).kind,
    ).toBe("unknown");
    expect(
      classifyVkRpcCaller({ ...base, ownerAuth, header: headers({ [VK_CLIENT_HEADER]: "cli-in-thread" }) }).kind,
    ).toBe("agent-thread");
    expect(
      classifyVkRpcCaller({
        ...base,
        ownerAuth: { enforced: true, proof: { kind: "owner-cli", evidence: "owner-signature" } },
        header: headers({}),
      }),
    ).toEqual({ kind: "owner-cli", evidence: "owner-signature" });
    expect(
      classifyVkRpcCaller({
        ...base,
        ownerAuth: { enforced: true, proof: { kind: "owner-ui", evidence: "owner-session" } },
        header: headers({}),
      }),
    ).toEqual({ kind: "owner-ui", evidence: "owner-session" });
  });

  it("an agent token never becomes the owner, whatever proof is attached", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vk-owner-token-"));
    const token = createVkThreadToken(dataDir, "thr_a");
    const caller = classifyVkRpcCaller({
      ...base,
      dataDir,
      ownerAuth: { enforced: true, proof: { kind: "owner-cli", evidence: "owner-signature" } },
      header: headers({ [VK_THREAD_TOKEN_HEADER]: token }),
    });
    expect(caller.kind).toBe("agent-thread");
  });
});

describe("VK owner login: gated route table", () => {
  it("covers install, settings, the owner's forms and host file writes, and nothing the deploy script uses", () => {
    const yes: Array<[string, string]> = [
      ["POST", "/api/v1/plugins/install"],
      ["POST", "/api/v1/plugin-catalog/install"],
      ["POST", "/api/v1/marketplaces"],
      ["PUT", "/api/v1/plugins/lane-pilot/settings"],
      ["POST", "/api/v1/plugins/lane-pilot/update"],
      ["POST", "/api/v1/plugins/lane-pilot/token"],
      ["DELETE", "/api/v1/plugins/lane-pilot"],
      ["POST", "/api/v1/threads/thr_1/interactions/pint_abcdefghij/respond"],
      ["POST", "/api/v1/threads/thr_1/interactions/pint_abcdefghij/resolve"],
      ["POST", "/api/v1/threads/thr_1/interactions/pint_abcdefghij/cancel"],
      ["POST", "/api/v1/files/write"],
      ["POST", "/api/v1/files/remove"],
    ];
    const no: Array<[string, string]> = [
      ["GET", "/api/v1/plugins/lane-pilot/settings"],
      ["POST", "/api/v1/plugins/lane-pilot/rpc/save_setting"],
      ["POST", "/api/v1/plugins/reload"],
      ["POST", "/api/v1/plugins/lane-pilot/enable"],
      ["POST", "/api/v1/plugins/lane-pilot/disable"],
      ["POST", "/api/v1/plugins/updates/check"],
      ["POST", "/api/v1/files/read"],
      ["GET", "/api/v1/threads/thr_1/interactions"],
    ];
    for (const [method, path] of yes) expect(isVkOwnerGatedRoute(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of no) expect(isVkOwnerGatedRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

const WHO_SOURCE = `
  import { defineRpcContract } from "@get-bb/plugin-sdk";
  import { z } from "zod";
  const rpcContract = defineRpcContract({
    who: { input: z.null(), output: z.any() },
    writeFile: { input: z.null(), output: z.any() },
  });
  export default function plugin(bb: any) {
    bb.rpc.register(rpcContract, {
      who: async (_input: any, ctx: any) => ({ vk: ctx.experimental_vkCaller ?? null }),
      writeFile: async () => {
        try {
          await bb.sdk.files.write({ hostId: "host_missing", path: "/tmp/x", content: "x" });
          return { refusedByOwnerGate: false };
        } catch (error: any) {
          return { refusedByOwnerGate: /owner/i.test(String(error?.message ?? error)), message: String(error?.message ?? error) };
        }
      },
    });
  }
`;

describe("VK owner login: over HTTP", () => {
  let harness: TestAppHarness;
  let dataDir: string;

  beforeEach(async () => {
    harness = await createTestAppHarness({ devAppPort: 5173 });
    dataDir = harness.config.dataDir;
    const root = join(dataDir, "fixtures", "bb-plugin-vk-who");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-vk-who",
        version: "0.1.0",
        vk: { rpcCallerPolicy: true },
        bb: { name: "vk-who", description: "who", branding: { icon: "Zap" }, server: "./server.ts" },
      }),
    );
    await writeFile(join(root, "server.ts"), WHO_SOURCE);
    await harness.pluginService.installPath(root);
  });
  afterEach(async () => {
    delete process.env.BB_VK_OWNER_AUTH;
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  const post = (
    path: string,
    extra: Record<string, string> = {},
    body: unknown = {},
    method = "POST",
  ) =>
    harness.app.request(`${BASE}${API}${path}`, {
      method,
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  const code = async (response: Response): Promise<string | undefined> =>
    ((await response.json().catch(() => ({}))) as { code?: string }).code;

  const GATED: Array<[string, string]> = [
    ["POST", "/plugins/install"],
    ["PUT", "/plugins/lane-pilot/settings"],
    ["POST", "/threads/thr_x/interactions/pint_abcdefghij/respond"],
    ["POST", "/files/write"],
  ];

  async function pairOwner(past = true) {
    const pair = generateVkOwnerKeyPair();
    addVkOwnerKey(dataDir, {
      publicKey: pair.publicKey,
      label: "test",
      now: past ? Date.now() - VK_OWNER_ENFORCE_GRACE_MS - 1_000 : Date.now(),
    });
    process.env.BB_VK_OWNER_AUTH = "1";
    return pair;
  }

  function signed(
    pair: { privateKey: string; keyId: string },
    path: string,
    body: unknown = {},
    method = "POST",
  ): Record<string, string> {
    return {
      [VK_OWNER_SIG_HEADER]: signVkOwnerRequest({
        privateKey: pair.privateKey,
        keyId: pair.keyId,
        method,
        target: `${API}${path}`,
        body: new TextEncoder().encode(JSON.stringify(body)),
      }),
    };
  }

  it("login off: agent-marked callers are refused on the owner's forms only; plugin and file routes stay open", async () => {
    const token = createVkThreadToken(dataDir, "thr_agent1");
    for (const [method, path] of GATED) {
      const formRoute = path.includes("/interactions/");
      for (const extra of <Array<Record<string, string>>>[
        { [VK_THREAD_TOKEN_HEADER]: token }, // agent token
        { [VK_THREAD_TOKEN_HEADER]: "vkt1.thr_agent1.forged" }, // forged token
        { [VK_CLIENT_HEADER]: "cli-in-thread" }, // BB_THREAD_ID mark
      ]) {
        const response = await post(path, extra, {}, method);
        if (formRoute) {
          expect(response.status, `${method} ${path}`).toBe(403);
          expect(await code(response)).toBe("vk_agent_caller_refused");
        } else {
          // A PM ships its own plugin and installs guards with `bb file write` (owner, 2026-10-12).
          expect(await code(response) ?? "", `${method} ${path}`).not.toMatch(/^vk_/);
        }
      }
      // The owner's app and CLI (and a bare script) are not stopped by the gate.
      for (const extra of <Array<Record<string, string>>>[
        {},
        { [VK_CLIENT_HEADER]: "cli" },
        { origin: BASE, "sec-fetch-site": "same-origin" },
      ]) {
        const response = await post(path, extra, {}, method);
        expect(await code(response), `${method} ${path}`).not.toBe("vk_agent_caller_refused");
      }
    }
  });

  it("login off: a forged x-bb-vk-client header is not the owner for a plugin", async () => {
    await expect(readdir(dataDir)).resolves.not.toContain("vk-owner.json");
    const response = await post("/plugins/vk-who/rpc/who", { [VK_CLIENT_HEADER]: "cli" }, null);
    const body = (await response.json()) as { result: { vk: { kind: string } } };
    expect(body.result.vk.kind).toBe("unverified-owner");
    // Witness: nothing of owner login was created.
    expect(await readdir(dataDir)).not.toContain("vk-owner.json");
  });

  it("flag on but nothing paired: not enforced, so the owner cannot be locked out", async () => {
    process.env.BB_VK_OWNER_AUTH = "1";
    const response = await post("/plugins/install", {});
    expect(await code(response)).not.toBe("vk_owner_required");
    const agent = await post("/threads/thr_x/interactions/pint_abcdefghij/respond", {
      [VK_THREAD_TOKEN_HEADER]: createVkThreadToken(dataDir, "thr_a"),
    });
    expect(await code(agent)).toBe("vk_agent_caller_refused");
  });

  it("inside the grace after the first pairing nothing is locked, a session already works", async () => {
    const pair = await pairOwner(false);
    expect(isVkOwnerEnforced(dataDir)).toBe(false);
    const bare = await post("/plugins/install", {});
    expect(await code(bare)).not.toBe("vk_owner_required");
    const proofCall = await post("/plugins/vk-who/rpc/who", signed(pair, "/plugins/vk-who/rpc/who", null), null);
    expect(((await proofCall.json()) as { result: { vk: { kind: string } } }).result.vk.kind).toBe("owner-cli");
  });

  it("enforced: curl, forged headers, agent tokens and unsigned CLI are refused on gated routes", async () => {
    await pairOwner();
    const token = createVkThreadToken(dataDir, "thr_agent1");
    for (const [method, path] of GATED) {
      for (const extra of <Array<Record<string, string>>>[
        {},
        { [VK_CLIENT_HEADER]: "cli" }, // the live repro of the audit
        { origin: BASE, "sec-fetch-site": "same-origin" }, // forged browser marks
        { [VK_THREAD_TOKEN_HEADER]: token },
        { [VK_CLIENT_HEADER]: "cli-in-thread" },
      ]) {
        const response = await post(path, extra, {}, method);
        expect(response.status, `${method} ${path} ${JSON.stringify(extra)}`).toBe(403);
        expect(await code(response)).toBe("vk_owner_required");
      }
    }
  });

  it("enforced: a plugin sees unknown for forged marks and owner-cli for a signed call", async () => {
    const pair = await pairOwner();
    const who = async (extra: Record<string, string>) =>
      ((await (await post("/plugins/vk-who/rpc/who", extra, null)).json()) as {
        result: { vk: { kind: string; evidence: string } };
      }).result.vk;
    expect((await who({ [VK_CLIENT_HEADER]: "cli" })).kind).toBe("unknown");
    expect((await who({ origin: BASE, "sec-fetch-site": "same-origin" })).kind).toBe("unknown");
    expect(await who(signed(pair, "/plugins/vk-who/rpc/who", null))).toEqual({
      kind: "owner-cli",
      evidence: "owner-signature",
    });
    // An agent token with a valid signature attached is still an agent.
    const token = createVkThreadToken(dataDir, "thr_agent1");
    expect(
      (await who({ ...signed(pair, "/plugins/vk-who/rpc/who", null), [VK_THREAD_TOKEN_HEADER]: token })).kind,
    ).toBe("agent-thread");
  });

  it("enforced: a valid signature opens the gate once; tampering, replay and a stranger's key do not", async () => {
    const pair = await pairOwner();
    const path = "/threads/thr_x/interactions/pint_abcdefghij/respond";
    const body = { value: "yes" };
    const headersOk = signed(pair, path, body);
    const ok = await post(path, headersOk, body);
    expect(await code(ok)).not.toBe("vk_owner_required");
    // Replay of the very same signed request.
    expect(await code(await post(path, headersOk, body))).toBe("vk_owner_required");
    // Same signature, different body.
    const tampered = signed(pair, path, body);
    expect(await code(await post(path, tampered, { value: "no" }))).toBe("vk_owner_required");
    // A key the hub never paired.
    const stranger = generateVkOwnerKeyPair();
    expect(await code(await post(path, signed(stranger, path, body), body))).toBe("vk_owner_required");
    // Signed for another route.
    expect(await code(await post(path, signed(pair, "/files/write", body), body))).toBe("vk_owner_required");
  });

  it("enforced: respond-from-agent is refused even with the thread's own valid token", async () => {
    const pair = await pairOwner();
    const path = "/threads/thr_agent1/interactions/pint_abcdefghij/respond";
    const token = createVkThreadToken(dataDir, "thr_agent1");
    const response = await post(path, { ...signed(pair, path, {}), [VK_THREAD_TOKEN_HEADER]: token }, {});
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("vk_owner_required");
  });

  it("pairing, ticket login, session cookie, revoke", async () => {
    process.env.BB_VK_OWNER_AUTH = "1";
    const pair = generateVkOwnerKeyPair();
    const pairBody = { code: "x", publicKey: pair.publicKey, label: "mac" };
    expect(await code(await post("/vk/owner/pair", {}, pairBody))).toBe("vk_pairing_refused"); // no code pending
    const minted = createVkOwnerPairingCode(dataDir);
    expect(await code(await post("/vk/owner/pair", {}, { ...pairBody, code: "WRONG-WRONG" }))).toBe("vk_pairing_refused");
    const paired = await post("/vk/owner/pair", {}, { ...pairBody, code: minted.code });
    expect(paired.status).toBe(200);
    expect(readVkOwnerState(dataDir).keys.map((key) => key.id)).toEqual([pair.keyId]);
    expect(await code(await post("/vk/owner/pair", {}, { ...pairBody, code: minted.code }))).toBe("vk_pairing_refused"); // single use

    // Move the grace into the past so the gates enforce.
    const state = readVkOwnerState(dataDir);
    (await import("@bb/config/vk-owner-auth")).writeVkOwnerState(dataDir, { ...state, enforceFrom: 1 });

    // Ticket trade: sets an HttpOnly Strict cookie; a replayed ticket and a forged one are refused.
    const ticket = createVkOwnerTicket({ privateKey: pair.privateKey, keyId: pair.keyId });
    const login = await harness.app.request(`${BASE}${API}/vk/owner/session?ticket=${encodeURIComponent(ticket)}`);
    expect(login.status).toBe(302);
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^vk_owner=vko1\./);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const replay = await harness.app.request(`${BASE}${API}/vk/owner/session?ticket=${encodeURIComponent(ticket)}`);
    expect(replay.status).toBe(403);
    const stranger = generateVkOwnerKeyPair();
    const forged = createVkOwnerTicket({ privateKey: stranger.privateKey, keyId: pair.keyId });
    expect((await harness.app.request(`${BASE}${API}/vk/owner/session?ticket=${encodeURIComponent(forged)}`)).status).toBe(403);

    const cookie = setCookie.split(";")[0]!;
    const browser = { cookie, origin: BASE, "sec-fetch-site": "same-origin" };
    // The browser with the session passes the gate and is owner-ui for plugins.
    expect(await code(await post("/threads/thr_x/interactions/pint_abcdefghij/respond", browser, { value: 1 }))).not.toBe("vk_owner_required");
    const who = await post("/plugins/vk-who/rpc/who", browser, null);
    expect(((await who.json()) as { result: { vk: unknown } }).result.vk).toEqual({
      kind: "owner-ui",
      evidence: "owner-session",
    });
    // The cookie alone (a curl that stole it without browser marks), a forged cookie, an agent token: no.
    expect(await code(await post("/plugins/install", { cookie }))).toBe("vk_owner_required");
    expect(await code(await post("/plugins/install", { ...browser, cookie: `${cookie}x` }))).toBe("vk_owner_required");
    expect(
      await code(await post("/plugins/install", { ...browser, [VK_THREAD_TOKEN_HEADER]: createVkThreadToken(dataDir, "thr_a") })),
    ).toBe("vk_owner_required");
    const status = await harness.app.request(`${BASE}${API}/vk/owner/status`, {
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    expect(await status.json()).toMatchObject({ enabled: true, enforced: true, paired: true, owner: true });

    // Revoke from the hub shell: the cookie dies, enforcement stays.
    revokeVkOwnerKeys(dataDir);
    expect(await code(await post("/plugins/install", browser))).toBe("vk_owner_required");
  });

  it("losing a device: removing its key ends its sessions, a new pairing code from the hub shell recovers", async () => {
    const lost = await pairOwner();
    const other = generateVkOwnerKeyPair();
    addVkOwnerKey(dataDir, { publicKey: other.publicKey, label: "second", now: 1 });
    const path = "/files/write";
    expect(await code(await post(path, signed(lost, path), {}))).not.toBe("vk_owner_required");
    removeVkOwnerKey(dataDir, lost.keyId);
    expect(await code(await post(path, signed(lost, path), {}))).toBe("vk_owner_required");
    expect(await code(await post(path, signed(other, path), {}))).not.toBe("vk_owner_required");
  });

  it("a parent thread answers its sub-agents' forms; nobody answers their own or a stranger's", async () => {
    const { project, thread: parent } = seedThreadFixture(harness);
    const child = seedThread(harness.deps, { projectId: project.id, parentThreadId: parent.id });
    const pluginChild = seedThread(harness.deps, {
      projectId: project.id,
      originKind: "fork",
      originPluginId: "lane-pilot",
      sourceThreadId: child.id,
    });
    const stranger = seedThread(harness.deps, { projectId: project.id });
    const as = (id: string) => ({ [VK_THREAD_TOKEN_HEADER]: createVkThreadToken(dataDir, id) });
    const respond = (target: string, extra: Record<string, string>) =>
      post(`/threads/${target}/interactions/pint_abcdefghij/respond`, extra, { value: 1 });
    for (const enforced of [false, true]) {
      if (enforced) await pairOwner();
      expect(await code(await respond(child.id, as(parent.id)))).not.toMatch(/vk_/);
      expect(await code(await respond(pluginChild.id, as(parent.id)))).not.toMatch(/vk_/);
      const refusal = enforced ? "vk_owner_required" : "vk_agent_caller_refused";
      expect(await code(await respond(parent.id, as(parent.id)))).toBe(refusal); // its own form
      expect(await code(await respond(parent.id, as(child.id)))).toBe(refusal); // a helper answering up
      expect(await code(await respond(stranger.id, as(parent.id)))).toBe(refusal);
    }
  });

  it("every refusal says what the owner should do", async () => {
    const token = { [VK_THREAD_TOKEN_HEADER]: createVkThreadToken(dataDir, "thr_a") };
    const text = async (path: string, extra: Record<string, string>) =>
      ((await (await post(path, extra, {})).json()) as { message: string }).message;
    expect(await text("/threads/thr_x/interactions/pint_abcdefghij/respond", token)).toMatch(/Ask the owner to answer it/);
    await pairOwner();
    expect(await text("/plugins/install", token)).toMatch(/bb owner login/);
  });
});

describe("VK owner login: a loaded plugin's file tools", () => {
  it("keep working while login is enforced (the plugin's sdk carries its caller token)", async () => {
    const server = await startTestServer({ devAppPort: 5173 });
    try {
      const dataDir = server.config.dataDir;
      const root = join(dataDir, "fixtures", "bb-plugin-vk-who");
      await mkdir(root, { recursive: true });
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "bb-plugin-vk-who",
          version: "0.1.0",
          bb: { name: "vk-who", description: "who", branding: { icon: "Zap" }, server: "./server.ts" },
        }),
      );
      await writeFile(join(root, "server.ts"), WHO_SOURCE);
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      await server.pluginService.installPath(root);
      const pair = generateVkOwnerKeyPair();
      addVkOwnerKey(dataDir, { publicKey: pair.publicKey, label: "t", now: 1 });
      process.env.BB_VK_OWNER_AUTH = "1";
      const call = async (headers: Record<string, string>) =>
        (await (await fetch(`${server.baseUrl}${API}/plugins/vk-who/rpc/writeFile`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "null",
        })).json()) as { result: { message?: string } };
      // Direct, unmarked: the gate refuses (control). Through the plugin's tool: not refused.
      const direct = await fetch(`${server.baseUrl}${API}/files/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "host_missing", path: "/tmp/x", content: "x" }),
      });
      expect(direct.status).toBe(403);
      const viaPlugin = await call({});
      expect(viaPlugin.result.message ?? "").toMatch(/host/i);
      expect(viaPlugin.result.message ?? "").not.toMatch(/owner/i);
    } finally {
      delete process.env.BB_VK_OWNER_AUTH;
      await server.pluginService.stop();
      await server.close();
    }
  });
});
