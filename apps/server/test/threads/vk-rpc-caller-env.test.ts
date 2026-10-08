import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveThreadRuntimeCommandConfig } from "../../src/services/threads/thread-runtime-config.js";
import {
  VK_THREAD_TOKEN_ENV,
  verifyVkThreadToken,
} from "../../src/services/plugins/vk-rpc-caller.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function runtimeEnv(harness: TestAppHarness) {
  const hostId = "host-vk-rpc-caller-env";
  seedHostSession(harness.deps, { id: hostId });
  const workspacePath = path.join(harness.config.dataDir, "vk-rpc-caller");
  const { project } = seedProjectWithSource(harness.deps, {
    hostId,
    path: workspacePath,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId,
    projectId: project.id,
    path: workspacePath,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
  });
  const config = await resolveThreadRuntimeCommandConfig(harness.deps, {
    thread,
    model: "test-model",
    environment: {
      hostId: environment.hostId,
      id: environment.id,
      path: environment.path,
      status: environment.status,
    },
  });
  return { thread, entries: config.contributedEnv };
}

async function installPlugin(
  harness: TestAppHarness,
  vk: Record<string, unknown> | undefined,
): Promise<void> {
  const rootDir = path.join(harness.config.dataDir, "fixtures", "bb-plugin-vk-env");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-vk-env",
      version: "0.1.0",
      ...(vk === undefined ? {} : { vk }),
      bb: {
        name: "vk env",
        description: "fixture",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    path.join(rootDir, "server.ts"),
    "export default function plugin(_bb: any) {}\n",
  );
  const entry = await harness.pluginService.installPath(rootDir);
  expect(entry.status).toBe("running");
}

describe("VK rpc caller: per-thread token in the agent's environment", () => {
  it("adds BB_VK_THREAD_TOKEN, verifiable for exactly that thread, as a masked core entry, while a plugin declares the policy", async () => {
    await withTestHarness(async (harness) => {
      await installPlugin(harness, { rpcCallerPolicy: true });
      const { thread, entries } = await runtimeEnv(harness);
      const found = entries.filter((entry) => entry.name === VK_THREAD_TOKEN_ENV);
      expect(found).toHaveLength(1);
      const entry = found[0]!;
      expect(entry.source).toEqual({ core: "machine-environment" });
      expect(typeof entry.value).toBe("string");
      expect(
        verifyVkThreadToken(harness.config.dataDir, entry.value as string),
      ).toBe(thread.id);
    });
  });

  it("witness: no plugin declares the policy, so the stock environment has no token", async () => {
    await withTestHarness(async (harness) => {
      await installPlugin(harness, undefined);
      const { entries } = await runtimeEnv(harness);
      expect(entries.some((entry) => entry.name === VK_THREAD_TOKEN_ENV)).toBe(false);
    });
  });
});
