import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { threadPluginMetadata } from "@bb/db";
import { VK_LAUNCH_TUNING_METADATA_KEY } from "@bb/domain/vk-launch-tuning";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../src/services/threads/thread-commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import type { TestAppHarness } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

// VK EXPERIMENTAL: a plugin's launch tuning (plugin metadata) reaches the bridge as the `vkLaunchTuning` provider option.

async function seedWithMetadata(
  harness: TestAppHarness,
  hostId: string,
  metadata: Record<string, unknown> | null,
  providerId = "acp-cursor",
) {
  seedHostSession(harness.deps, { id: hostId });
  const workspacePath = path.join(harness.config.dataDir, `${hostId}-ws`);
  const { project } = seedProjectWithSource(harness.deps, { hostId, path: workspacePath });
  const environment = seedEnvironment(harness.deps, { hostId, projectId: project.id, path: workspacePath });
  const thread = seedThread(harness.deps, { projectId: project.id, environmentId: environment.id, providerId });
  if (metadata !== null) {
    harness.deps.db
      .insert(threadPluginMetadata)
      .values({ threadId: thread.id, pluginId: "lane-pilot", metadataJson: JSON.stringify(metadata) })
      .run();
  }
  return { environment, project, thread };
}

async function startOptions(harness: TestAppHarness, seeded: Awaited<ReturnType<typeof seedWithMetadata>>) {
  const execution = await buildExecutionOptions(harness.deps, { model: "test-model" }, { threadId: seeded.thread.id });
  const command = await buildThreadStartCommand(harness.deps, {
    environment: seeded.environment,
    execution,
    fork: null,
    permissionEscalation: "ask",
    input: textInput("hello"),
    projectId: seeded.project.id,
    providerId: seeded.thread.providerId,
    requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
    syncGeneratedTitle: false,
    thread: seeded.thread,
  });
  return command.options.providerOptions ?? {};
}

describe("vk launch tuning", () => {
  it("sends the tuning the spawning plugin stored to the bridge", async () => {
    await withTestHarness(async (harness) => {
      const tuning = { version: 1, acp: { mode: "ask" }, claude: { disallowedTools: ["Edit"] } };
      const seeded = await seedWithMetadata(harness, "host-vk-tune", { role: "code-critic", [VK_LAUNCH_TUNING_METADATA_KEY]: tuning });
      expect((await startOptions(harness, seeded)).vkLaunchTuning).toEqual(tuning);
    });
  });

  it("adds nothing when the plugin set no tuning, a wrong version, or no metadata at all", async () => {
    await withTestHarness(async (harness) => {
      const none = await seedWithMetadata(harness, "host-vk-none", null);
      const plain = await seedWithMetadata(harness, "host-vk-plain", { role: "writer" });
      const bad = await seedWithMetadata(harness, "host-vk-bad", { [VK_LAUNCH_TUNING_METADATA_KEY]: { version: 7, acp: { mode: "ask" } } });
      for (const seeded of [none, plain, bad]) {
        expect(await startOptions(harness, seeded)).not.toHaveProperty("vkLaunchTuning");
      }
    });
  });
});
