import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyVkRpcCaller,
  createVkThreadToken,
  readVkRpcCallerManifest,
  VK_CLIENT_HEADER,
  VK_THREAD_TOKEN_HEADER,
  verifyVkThreadToken,
} from "../../../src/services/plugins/vk-rpc-caller.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";

function headers(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()];
}

describe("VK rpc caller: tokens and classification", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "vk-rpc-caller-"));
  });

  it("round-trips a thread token and keeps the key private to the data dir", async () => {
    const token = createVkThreadToken(dataDir, "thr_abc123");
    expect(verifyVkThreadToken(dataDir, token)).toBe("thr_abc123");
    const mode = (await stat(join(dataDir, "vk-rpc-caller.key"))).mode & 0o777;
    expect(mode).toBe(0o600);
    // A second data dir has its own key: the token is not valid there.
    const other = await mkdtemp(join(tmpdir(), "vk-rpc-caller-"));
    expect(verifyVkThreadToken(other, token)).toBeNull();
  });

  it("rejects forged, truncated and re-targeted tokens", () => {
    const token = createVkThreadToken(dataDir, "thr_abc123");
    const [prefix, , signature] = token.split(".");
    expect(verifyVkThreadToken(dataDir, undefined)).toBeNull();
    expect(verifyVkThreadToken(dataDir, "")).toBeNull();
    expect(verifyVkThreadToken(dataDir, "vkt1.thr_abc123")).toBeNull();
    expect(verifyVkThreadToken(dataDir, `${prefix}.thr_other.${signature}`)).toBeNull();
    expect(verifyVkThreadToken(dataDir, `${prefix}.thr_abc123.${signature}x`)).toBeNull();
    expect(verifyVkThreadToken(dataDir, `bad.thr_abc123.${signature}`)).toBeNull();
    expect(verifyVkThreadToken(dataDir, `${prefix}.a b.${signature}`)).toBeNull();
  });

  it("classifies every kind of caller", () => {
    const token = createVkThreadToken(dataDir, "thr_abc123");
    const base = { pluginCaller: { kind: "client" } as const, browserGuardPassed: true, dataDir };
    expect(
      classifyVkRpcCaller({ ...base, header: headers({}) }),
    ).toEqual({ kind: "unknown", evidence: "none" });
    expect(
      classifyVkRpcCaller({
        ...base,
        header: headers({ [VK_THREAD_TOKEN_HEADER]: token, [VK_CLIENT_HEADER]: "cli" }),
      }),
    ).toEqual({ kind: "agent-thread", threadId: "thr_abc123", evidence: "thread-token" });
    // The token wins over browser marks: an agent cannot raise itself by adding them.
    expect(
      classifyVkRpcCaller({
        ...base,
        header: headers({
          [VK_THREAD_TOKEN_HEADER]: token,
          origin: BASE,
          "sec-fetch-site": "same-origin",
        }),
      }).kind,
    ).toBe("agent-thread");
    // A forged token is not an anonymous call that may pass as the CLI.
    expect(
      classifyVkRpcCaller({
        ...base,
        header: headers({ [VK_THREAD_TOKEN_HEADER]: "vkt1.thr_abc123.zzz", [VK_CLIENT_HEADER]: "cli" }),
      }).kind,
    ).toBe("unknown");
    expect(
      classifyVkRpcCaller({
        ...base,
        header: headers({ origin: BASE, "sec-fetch-site": "same-origin" }),
      }),
    ).toEqual({ kind: "owner-ui", evidence: "browser-headers" });
    expect(
      classifyVkRpcCaller({
        ...base,
        header: headers({ origin: BASE, "sec-fetch-site": "same-site" }),
      }).kind,
    ).toBe("owner-ui");
    // An Origin alone (what a bare curl -H adds) is not enough.
    expect(classifyVkRpcCaller({ ...base, header: headers({ origin: BASE }) }).kind).toBe("unknown");
    expect(
      classifyVkRpcCaller({
        ...base,
        browserGuardPassed: false,
        header: headers({ origin: BASE, "sec-fetch-site": "same-origin" }),
      }).kind,
    ).toBe("unknown");
    expect(
      classifyVkRpcCaller({ ...base, header: headers({ [VK_CLIENT_HEADER]: "cli" }) }),
    ).toEqual({ kind: "owner-cli", evidence: "cli-header" });
    // The CLI inside a session without a token is still an agent.
    expect(
      classifyVkRpcCaller({ ...base, header: headers({ [VK_CLIENT_HEADER]: "cli-in-thread" }) }).kind,
    ).toBe("agent-thread");
    expect(
      classifyVkRpcCaller({
        ...base,
        pluginCaller: { kind: "plugin", pluginId: "env-catalog" },
        header: headers({}),
      }),
    ).toEqual({ kind: "plugin", pluginId: "env-catalog", evidence: "plugin-token" });
  });

  it("reads only an explicit true", () => {
    expect(readVkRpcCallerManifest({ rpcCallerPolicy: true })).toEqual({ vkRpcCallerPolicy: true });
    expect(readVkRpcCallerManifest({ rpcCallerPolicy: "yes" })).toEqual({});
    expect(readVkRpcCallerManifest({ hookPolicy: {} })).toEqual({});
    expect(readVkRpcCallerManifest(undefined)).toEqual({});
  });
});

const SOURCE = `
  import { defineRpcContract } from "@get-bb/plugin-sdk";
  import { z } from "zod";
  const rpcContract = defineRpcContract({
    who: { input: z.null(), output: z.any() },
  });
  export default function plugin(bb: any) {
    bb.rpc.register(rpcContract, {
      who: async (_input: any, ctx: any) => ({
        vk: ctx.experimental_vkCaller ?? null,
        hasVkKey: "experimental_vkCaller" in ctx,
        caller: ctx.experimental_caller,
      }),
    });
    bb.cli.register({
      name: "__NAME__",
      summary: "who",
      commands: [{ name: "who", summary: "who", usage: "bb __NAME__ who" }],
      run: async (_argv: string[], ctx: any) => ({
        exitCode: 0,
        stdout: JSON.stringify({ vk: ctx.experimental_vkCaller ?? null, hasVkKey: "experimental_vkCaller" in ctx }),
      }),
    });
  }
`;

async function writePlugin(
  dir: string,
  name: string,
  vk: Record<string, unknown> | undefined,
): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      ...(vk === undefined ? {} : { vk }),
      bb: {
        name,
        description: "caller fixture",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), SOURCE.replaceAll("__NAME__", name.replace("bb-plugin-", "")));
  return rootDir;
}

describe("VK rpc caller: handler context over HTTP", () => {
  let harness: TestAppHarness;
  beforeEach(async () => {
    harness = await createTestAppHarness({ devAppPort: 5173 });
    const fixtures = join(harness.config.dataDir, "fixtures");
    await harness.pluginService.installPath(
      await writePlugin(fixtures, "bb-plugin-vk-declared", { rpcCallerPolicy: true }),
    );
    await harness.pluginService.installPath(
      await writePlugin(fixtures, "bb-plugin-vk-stock", undefined),
    );
  });
  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  async function who(
    id: string,
    extra: Record<string, string>,
  ): Promise<{ vk: unknown; hasVkKey: boolean }> {
    const response = await harness.app.request(`${BASE}/api/v1/plugins/${id}/rpc/who`, {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: "null",
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: { vk: unknown; hasVkKey: boolean } }).result;
  }

  it("marks a plain script unknown, the app owner-ui, the CLI owner-cli and an agent agent-thread", async () => {
    const id = "vk-declared";
    expect((await who(id, {})).vk).toEqual({ kind: "unknown", evidence: "none" });
    expect(
      (await who(id, { origin: BASE, "sec-fetch-site": "same-origin" })).vk,
    ).toEqual({ kind: "owner-ui", evidence: "browser-headers" });
    expect((await who(id, { [VK_CLIENT_HEADER]: "cli" })).vk).toEqual({
      kind: "owner-cli",
      evidence: "cli-header",
    });
    const token = createVkThreadToken(harness.config.dataDir, "thr_agent1");
    expect((await who(id, { [VK_THREAD_TOKEN_HEADER]: token })).vk).toEqual({
      kind: "agent-thread",
      threadId: "thr_agent1",
      evidence: "thread-token",
    });
  });

  it("witness: a plugin that did not opt in gets the stock context, whoever calls", async () => {
    const id = "vk-stock";
    const token = createVkThreadToken(harness.config.dataDir, "thr_agent1");
    const calls: Record<string, string>[] = [
      {},
      { [VK_CLIENT_HEADER]: "cli" },
      { [VK_THREAD_TOKEN_HEADER]: token },
      { origin: BASE, "sec-fetch-site": "same-origin" },
    ];
    for (const extra of calls) {
      const seen = await who(id, extra);
      expect(seen.vk).toBeNull();
      expect(seen.hasVkKey).toBe(false);
    }
  });

  it("hands the mark to a declared plugin's CLI command and withholds it from a stock one", async () => {
    const run = async (id: string, extra: Record<string, string>) => {
      const response = await harness.app.request(`${BASE}/api/v1/plugins/${id}/cli`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify({ argv: [] }),
      });
      const text = await response.text();
      return JSON.parse(text.trim().split("\n").filter(Boolean).pop()!) as {
        stdout: string;
      };
    };
    const declared = await run("vk-declared", { [VK_CLIENT_HEADER]: "cli" });
    expect(JSON.parse(declared.stdout).vk).toEqual({ kind: "owner-cli", evidence: "cli-header" });
    const bare = await run("vk-declared", {});
    expect(JSON.parse(bare.stdout).vk.kind).toBe("unknown");
    const stock = await run("vk-stock", { [VK_CLIENT_HEADER]: "cli" });
    expect(JSON.parse(stock.stdout)).toEqual({ vk: null, hasVkKey: false });
  });
});
