import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const BASE = "http://127.0.0.1:3334";

const DOOR_SOURCE = `
  import { defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
  import { z } from "zod";
  const rpcContract = defineRpcContract({
    ping: { input: z.object({ n: z.number() }), output: z.object({ pong: z.number() }) },
    refuse: {
      input: z.enum(["forbidden", "not_found", "conflict", "invalid"]),
      output: z.null(),
    },
  });
  export default function plugin(bb: any) {
    bb.rpc.register(rpcContract, {
      ping: async (input: any) => ({ pong: input.n + 1 }),
      refuse: async (code: any) => {
        throw new experimental_PluginRpcRefusal({ code, message: "refused: " + code });
      },
    });
  }
`;

function rpc(
  harness: TestAppHarness,
  pluginId: string,
  method: string,
  input: unknown,
): Promise<Response> {
  return Promise.resolve(
    harness.app.request(`${BASE}/api/v1/plugins/${pluginId}/rpc/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

describe("plugin door (core)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-door");
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-door",
        version: "0.1.0",
        bb: {
          name: "Door fixture",
          description: "Door fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), DOOR_SOURCE);
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("[sma:m_gt_server] the plugin door is a closed table behind one dispatcher: a declared method is answered, anything else is a refusal with a fixed status", async () => {
    const ok = await rpc(harness, "door", "ping", { n: 41 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, result: { pong: 42 } });

    const undeclared = await rpc(harness, "door", "not_in_the_table", {});
    expect(undeclared.status).toBe(404);
    expect(await undeclared.json()).toEqual({
      ok: false,
      error: {
        code: "unknown_method",
        message: 'plugin "door" has no rpc method "not_in_the_table"',
      },
    });

    const noPlugin = await rpc(harness, "nobody", "ping", {});
    expect(noPlugin.status).toBe(404);
    expect(await noPlugin.json()).toEqual({
      ok: false,
      error: 'unknown plugin "nobody"',
    });

    // the dispatcher answers a refusal code with one status each
    for (const [code, status] of [
      ["forbidden", 403],
      ["not_found", 404],
      ["conflict", 409],
      ["invalid", 422],
    ] as const) {
      const refused = await rpc(harness, "door", "refuse", code);
      expect(refused.status).toBe(status);
      expect(await refused.json()).toMatchObject({
        ok: false,
        error: { code, message: `refused: ${code}` },
      });
    }

    // a body that is not JSON never reaches a handler
    const notJson = await harness.app.request(
      `${BASE}/api/v1/plugins/door/rpc/ping`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_json" },
    });
  });
});
