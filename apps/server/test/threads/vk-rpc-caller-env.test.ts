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
import { withTestHarness } from "../helpers/test-app.js";

describe("VK rpc caller: per-thread token in the agent's environment", () => {
  it("adds BB_VK_THREAD_TOKEN, verifiable for exactly that thread, as a masked core entry", async () => {
    await withTestHarness(async (harness) => {
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
      const entries = config.contributedEnv.filter(
        (entry) => entry.name === VK_THREAD_TOKEN_ENV,
      );
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.source).toEqual({ core: "machine-environment" });
      expect(typeof entry.value).toBe("string");
      expect(verifyVkThreadToken(harness.config.dataDir, entry.value as string)).toBe(
        thread.id,
      );
    });
  });
});
