import { afterEach, describe, expect, it } from "vitest";
import { createEnvironment, getThread, updateThread } from "@bb/db";
import {
  invokePluginInline,
  setPluginHookProvider,
} from "../../../src/services/plugins/plugin-hook-registry.js";
import { handleUpdateEnvironmentDirectoryToolCall } from "../../../src/services/threads/thread-environment-directory.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

afterEach(() => setPluginHookProvider(undefined));

function installHook(
  invoke: (
    input: Record<string, unknown>,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: string }>,
): void {
  setPluginHookProvider({
    listHooks: () => [],
    invokeHook: (_registration, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
    vkDirectoryMoveCapability: () => ({
      kind: "available",
      pluginId: "lane-pilot",
    }),
    invokeVkDirectoryMove: (input) => invoke(input as Record<string, unknown>),
  });
}

function fixture(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host_move" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/move-source",
  });
  const source = createEnvironment(harness.db, harness.hub, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/move-source",
    status: "ready",
    providerOwnsPath: false,
  });
  const target = createEnvironment(harness.db, harness.hub, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/move-target",
    status: "ready",
    providerOwnsPath: false,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: source.id,
    status: "starting",
  });
  return { project, source, target, thread };
}

describe("VK directory move checkpoint", () => {
  it("vetoes before attach and leaves the thread on its source environment", async () =>
    withTestHarness(async (harness) => {
      const state = fixture(harness);
      const calls: Record<string, unknown>[] = [];
      installHook(async (input) => {
        calls.push(input);
        return { ok: false, error: "active work" };
      });
      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: state.source,
          thread: state.thread,
          turnId: "turn_move",
          input: { path: state.target.path },
        },
      );
      expect(result.success).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.phase).toBe("prepare");
      expect(getThread(harness.db, state.thread.id)?.environmentId).toBe(
        state.source.id,
      );
    }));

  it("aborts a prepared move when attach loses the thread race", async () =>
    withTestHarness(async (harness) => {
      const state = fixture(harness);
      const calls: Record<string, unknown>[] = [];
      const other = createEnvironment(harness.db, harness.hub, {
        projectId: state.project.id,
        hostId: state.source.hostId,
        path: "/tmp/move-other",
        status: "ready",
        providerOwnsPath: false,
      });
      installHook(async (input) => {
        calls.push(input);
        if (input.phase === "prepare") {
          updateThread(harness.db, harness.hub, state.thread.id, {
            environmentId: other.id,
          });
        }
        return { ok: true, value: { ok: true } };
      });
      const result = await handleUpdateEnvironmentDirectoryToolCall(
        harness.deps,
        {
          currentEnvironment: state.source,
          thread: state.thread,
          turnId: "turn_move",
          input: { path: state.target.path },
        },
      );
      expect(result.success).toBe(false);
      expect(calls.map((call) => call.phase)).toEqual(["prepare", "abort"]);
      expect(getThread(harness.db, state.thread.id)?.environmentId).toBe(
        other.id,
      );
    }));
});
