import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

// VK EXPERIMENTAL: bb.agents.experimental_vkSessionPolicy end to end through
// the plugin service.

const logger = testLogger as unknown as Logger;

async function writePlugin(
  dir: string,
  name: string,
  serverSource: string,
): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      bb: {
        name: "VK policy fixture",
        description: "Session policy plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), serverSource);
  return rootDir;
}

const context = {
  thread: {
    id: "thr_1",
    title: null,
    parentThreadId: null,
    sourceThreadId: null,
  },
  project: { id: "proj_1", kind: "local", name: "P", gitRemoteUrl: null },
  environment: {
    id: "env_1",
    name: "E",
    path: "/work",
    branchName: null,
    workspaceProvisionType: "unmanaged",
  },
  host: { id: "host_1", name: "H" },
  provider: {
    id: "claude-code",
    model: "m",
    capabilities: { supportsNativeUserQuestion: false },
  },
  origin: { kind: "user", pluginId: null },
} as unknown as Parameters<
  PluginService["resolveVkSessionPolicy"]
>[0]["context"];

describe("bb.agents.experimental_vkSessionPolicy", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-vk-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns the first valid policy in plugin id order, skipping invalid ones", async () => {
    await service.installPath(
      await writePlugin(
        workDir,
        "bb-plugin-aaa-broken",
        `export default function plugin(bb: any) {
          bb.agents.experimental_vkSessionPolicy(() => ({ skills: { mode: "only", names: [] } }));
        }`,
      ),
    );
    await service.installPath(
      await writePlugin(
        workDir,
        "bb-plugin-bbb-good",
        `export default function plugin(bb: any) {
          bb.agents.experimental_vkSessionPolicy(async (ctx: any) =>
            ctx.environment.path === "/work"
              ? { bbPlugins: { mode: "deny", names: ["noise"] } }
              : null);
        }`,
      ),
    );
    await expect(service.resolveVkSessionPolicy({ context })).resolves.toEqual({
      pluginId: "bbb-good",
      policy: { bbPlugins: { mode: "deny", names: ["noise"] } },
    });
  });

  it("is null when no plugin registers a resolver", async () => {
    await service.installPath(
      await writePlugin(
        workDir,
        "bb-plugin-quiet",
        "export default function plugin() {}",
      ),
    );
    await expect(
      service.resolveVkSessionPolicy({ context }),
    ).resolves.toBeNull();
  });

  it("rejects a second registration in one factory", async () => {
    await service.installPath(
      await writePlugin(
        workDir,
        "bb-plugin-twice",
        `export default function plugin(bb: any) {
          bb.agents.experimental_vkSessionPolicy(() => null);
          try { bb.agents.experimental_vkSessionPolicy(() => null); }
          catch (e: any) { (globalThis as any).__vkTwice = e.message; }
        }`,
      ),
    );
    expect((globalThis as { __vkTwice?: string }).__vkTwice).toBe(
      "session policy resolver is already registered",
    );
  });
});
