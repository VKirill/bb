import { listEvents } from "@bb/db";
import type { ExperimentalVkHookPolicy } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { createVkHookPolicyApi } from "../../src/services/plugins/vk-hook-policy.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

// VK EXPERIMENTAL: per-plugin message.dispatch decision box (vk.hookPolicy.messageDispatch).

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function installHooks(
  handlers: PluginHookRegistration<"message.dispatch">[],
  policies: Record<string, ExperimentalVkHookPolicy>,
  decisionTimeoutMs: number,
): void {
  setPluginHookProvider({
    listHooks: () => handlers as never,
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs,
    vkHookPolicy: (pluginId) => policies[pluginId],
  });
}

afterEach(() => setPluginHookProvider(undefined));

function seedIdleThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/vk-hook-dispatch",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/vk-hook-dispatch",
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    threadId: thread.id,
  });
  return thread;
}

function send(
  harness: TestAppHarness,
  thread: ReturnType<typeof seedIdleThread>,
) {
  return acceptThreadSendRequest(harness.deps, {
    payload: { input: textInput("hi"), mode: "auto" },
    thread,
  });
}

async function failureOf(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the send to fail");
}

const timeoutRows = (harness: TestAppHarness, threadId: string) =>
  listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/error")
    .map((event) => JSON.parse(event.data) as { code: string; message: string })
    .filter((data) => data.code === "vk_hook_timeout");

describe("vk.hookPolicy.messageDispatch", () => {
  it("a declared limit lets a slow handler decide where the stock box would fail the dispatch", async () => {
    await withTestHarness(async (harness) => {
      const slow = async () => {
        await sleep(80);
        return { action: "proceed" } as const;
      };
      installHooks(
        [{ pluginId: "declared", handler: slow }],
        { declared: { messageDispatch: { timeoutMs: 400 } } },
        20,
      );
      await send(harness, seedIdleThread(harness, "host-vk-declared"));

      // Stock witness: the same handler without a policy still fails at the stock box, silently.
      installHooks([{ pluginId: "stock", handler: slow }], {}, 20);
      const thread = seedIdleThread(harness, "host-vk-stock");
      const calls: unknown[] = [];
      createVkHookPolicyApi({
        pluginId: "stock",
        assertLive: () => {},
        onDispose: () => {},
      }).experimental_vkOnHookTimeout((event) => {
        calls.push(event);
      });
      const error = await failureOf(() => send(harness, thread));
      expect(error.status).toBe(502);
      expect(error.body.code).toBe("dispatch_hook_failed");
      expect(error.body.message).toContain("did not decide within 20ms");
      await sleep(10);
      expect(calls).toEqual([]);
      expect(timeoutRows(harness, thread.id)).toEqual([]);
    });
  });

  it("a timeout of a declared hook still fails the dispatch, appends a row and calls the callbacks", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedIdleThread(harness, "host-vk-timeout");
      const calls: unknown[] = [];
      createVkHookPolicyApi({
        pluginId: "declared",
        assertLive: () => {},
        onDispose: () => {},
      }).experimental_vkOnHookTimeout((event) => {
        calls.push(event);
      });
      installHooks(
        [{ pluginId: "declared", handler: () => sleep(300) as never }],
        { declared: { messageDispatch: { timeoutMs: 40 } } },
        10_000,
      );
      const error = await failureOf(() => send(harness, thread));
      expect(error.body.code).toBe("dispatch_hook_failed");
      await sleep(10);
      expect(calls).toEqual([
        {
          hook: "messageDispatch",
          pluginId: "declared",
          timeoutMs: 40,
          threadId: thread.id,
          projectId: thread.projectId,
          required: false,
        },
      ]);
      expect(timeoutRows(harness, thread.id)).toEqual([
        {
          code: "vk_hook_timeout",
          message:
            "plugin declared did not answer in 40 ms: dispatch hook not applied",
        },
      ]);
    });
  });

  it("a handler error of a declared hook is not reported as a timeout", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedIdleThread(harness, "host-vk-throw");
      installHooks(
        [
          {
            pluginId: "declared",
            handler: () => {
              throw new Error("handler exploded");
            },
          },
        ],
        { declared: { messageDispatch: { timeoutMs: 400 } } },
        10_000,
      );
      const error = await failureOf(() => send(harness, thread));
      expect(error.body.message).toContain("handler exploded");
      expect(timeoutRows(harness, thread.id)).toEqual([]);
    });
  });
});
