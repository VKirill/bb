import {
  insertThreadPluginMetadata,
  listQueuedThreadMessages,
  setExperiments,
  VK_QUIET_CHILD_KEY,
} from "@bb/db";
import { listEvents } from "@bb/db/testing";
import { encodeClientTurnRequestIdNumber, threadScope, turnRequestEventDataSchema } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { deliverDetachedToolResult } from "../../src/services/plugins/detached-tool-result-delivery.js";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

// VK EXPERIMENTAL (features-settings): each VK switch in Settings -> «Функции VK» really stops its function.

function seedParent(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-vk-gates" });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/vk-gates",
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/vk-gates",
  });
  const parent = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: "provider-vk-gates",
    threadId: parent.id,
  });
  return { project, parent };
}

async function notifyParent(
  harness: TestAppHarness,
  child: ReturnType<typeof seedThread>,
  parentId: string,
): Promise<number> {
  await queueChildThreadTurnNotificationBestEffort(harness.deps, {
    childThread: child,
    parentThreadId: parentId,
    turnStatus: "completed",
    turnId: null,
  });
  return listQueuedThreadMessages(harness.db, parentId).length;
}

describe("vkQuietChild", () => {
  it("mutes a quiet child while on and notifies the parent once off", async () => {
    await withTestHarness(async (harness) => {
      const { project, parent } = seedParent(harness);
      const child = seedThread(harness.deps, { parentThreadId: parent.id, projectId: project.id });
      insertThreadPluginMetadata(harness.db, {
        threadId: child.id,
        pluginId: "lane-pilot",
        metadata: { [VK_QUIET_CHILD_KEY]: true },
      });
      expect(await notifyParent(harness, child, parent.id)).toBe(0);
      setExperiments(harness.db, { vkQuietChild: false });
      expect(await notifyParent(harness, child, parent.id)).toBe(1);
    });
  });
});

describe("vkChildToldParent", () => {
  it("skips the second notice while on and sends it once off", async () => {
    await withTestHarness(async (harness) => {
      const { project, parent } = seedParent(harness);
      const child = seedThread(harness.deps, { parentThreadId: parent.id, projectId: project.id });
      seedStoredEvent(harness.deps, {
        threadId: parent.id,
        sequence: 500,
        scope: threadScope(),
        type: "client/turn/requested",
        createdAt: Date.now(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 500 }),
          input: [{ type: "text", text: "done" }],
          target: { kind: "new-turn" },
          execution: { model: "gpt-5", serviceTier: "default", reasoningLevel: "medium", permissionMode: "full", source: "client/turn/requested" },
          initiator: "agent",
          senderThreadId: child.id,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      expect(await notifyParent(harness, child, parent.id)).toBe(0);
      setExperiments(harness.db, { vkChildToldParent: false });
      expect(await notifyParent(harness, child, parent.id)).toBe(1);
    });
  });
});

describe("vkDeliveredLabel", () => {
  it("titles the delivered result with the plugin label while on and drops it once off", async () => {
    await withTestHarness(async (harness) => {
      const { parent } = seedParent(harness);
      const deliver = () =>
        deliverDetachedToolResult(harness.deps, {
          threadId: parent.id,
          toolName: "lane_pilot_ask_owner",
          presentation: { label: { completed: "Владелец ответил" } } as never,
          response: { success: true, contentItems: [{ type: "inputText", text: "ok" }] } as never,
        });
      const subjects = () =>
        listEvents(harness.db, { threadId: parent.id })
          .filter((event) => event.type === "client/turn/requested")
          .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)).systemMessageSubject);
      await deliver();
      expect(subjects().at(-1)).toMatchObject({ label: "Владелец ответил" });
    });
  });
});

describe("vkDeliveredLabel off", () => {
  it("delivers the result without the plugin label", async () => {
    await withTestHarness(async (harness) => {
      const { parent } = seedParent(harness);
      setExperiments(harness.db, { vkDeliveredLabel: false });
      await deliverDetachedToolResult(harness.deps, {
        threadId: parent.id,
        toolName: "lane_pilot_ask_owner",
        presentation: { label: { completed: "Владелец ответил" } } as never,
        response: { success: true, contentItems: [{ type: "inputText", text: "ok" }] } as never,
      });
      const subject = listEvents(harness.db, { threadId: parent.id })
        .filter((event) => event.type === "client/turn/requested")
        .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)).systemMessageSubject)
        .at(-1);
      expect(subject).toMatchObject({ kind: "tool-call", toolName: "lane_pilot_ask_owner" });
      expect(subject).not.toHaveProperty("label");
    });
  });
});
