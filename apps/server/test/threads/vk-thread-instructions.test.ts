import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../src/services/threads/thread-commands.js";
import { createVkThreadInstructionsMethods } from "../../src/services/plugins/vk-thread-instructions.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

// VK EXPERIMENTAL (thread-instructions): the text sent with thread.start is what plugins read back.

describe("vk thread instructions", () => {
  it("records the instructions of thread.start and returns them to plugins", async () => {
    await withTestHarness(async (harness) => {
      const hostId = "host-vk-ti";
      seedHostSession(harness.deps, { id: hostId });
      const workspacePath = path.join(harness.config.dataDir, `${hostId}-ws`);
      const { project } = seedProjectWithSource(harness.deps, { hostId, path: workspacePath });
      const environment = seedEnvironment(harness.deps, { hostId, projectId: project.id, path: workspacePath });
      const thread = seedThread(harness.deps, { projectId: project.id, environmentId: environment.id, providerId: "codex" });
      const methods = createVkThreadInstructionsMethods({ db: harness.deps.db, assertLive: () => {} });

      expect(await methods.experimental_vkThreadInstructions(thread.id)).toBeNull();

      const execution = await buildExecutionOptions(harness.deps, { model: "test-model" }, { threadId: thread.id });
      const command = await buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("hello"),
        projectId: project.id,
        providerId: thread.providerId,
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        syncGeneratedTitle: false,
        thread,
      });

      const recorded = await methods.experimental_vkThreadInstructions(thread.id);
      expect(recorded?.start).toMatchObject({ text: command.instructions, providerId: "codex", model: "test-model" });
      expect(recorded?.latest).toBeNull();
      await expect(methods.experimental_vkThreadInstructions("thr_missing")).rejects.toThrow();
    });
  });
});
