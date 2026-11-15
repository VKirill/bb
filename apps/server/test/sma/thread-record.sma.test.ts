import { eq } from "drizzle-orm";
import { events } from "@bb/db";
import { threadScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  appendClientTurnEvent,
  appendThreadEvent,
  appendThreadEventInTransaction,
} from "../../src/services/threads/thread-events.js";
import { loadFailedTurn } from "../../src/services/threads/turn-failed.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

async function context() {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
  return { environment, harness, thread };
}

const execution = {
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  source: "client/turn/requested",
} as const;

describe("the thread record (core: thread-events, turn-failed, ws hub)", () => {
  it("[sma:m_cb_append] every event is appended as one stored row with the next sequence number, in order, with its data intact and none dropped", async () => {
    const { environment, harness, thread } = await context();
    try {
      const sequences = harness.db.transaction((tx) =>
        ["first words", "second words", "third words"].map((message) =>
          appendThreadEventInTransaction(tx, {
            threadId: thread.id,
            environmentId: environment.id,
            type: "system/error",
            scope: threadScope(),
            data: { message },
          }),
        ),
      );
      expect(sequences).toEqual([1, 2, 3]);
      const rows = harness.db
        .select({ sequence: events.sequence, type: events.type, data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all();
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
      expect(rows.map((row) => JSON.parse(row.data as string))).toEqual([
        { message: "first words" },
        { message: "second words" },
        { message: "third words" },
      ]);

      // the record is not trimmed: far more than two hundred appends all stay
      const more = harness.db.transaction((tx) =>
        Array.from({ length: 210 }, (_, index) =>
          appendThreadEventInTransaction(tx, {
            threadId: thread.id,
            environmentId: environment.id,
            type: "system/error",
            scope: threadScope(),
            data: { message: `bulk ${index}` },
          }),
        ),
      );
      expect(more[0]).toBe(4);
      expect(more[209]).toBe(213);
      expect(
        harness.db.select().from(events).where(eq(events.threadId, thread.id)).all(),
      ).toHaveLength(213);
    } finally {
      await harness.cleanup();
    }
  });

  it("[sma:m_ce_turn] a turn request is stored before any answer and is read back from the database alone: the last request, its sequence, nothing for a thread that never asked", async () => {
    const { environment, harness, thread } = await context();
    try {
      expect(loadFailedTurn(harness.db, thread.id)).toBeNull();

      const first = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: textInput("first question"),
        target: { kind: "new-turn" },
        execution,
        initiator: "user",
        senderThreadId: null,
        requestMethod: "turn/start",
        source: "tell",
      });
      const second = appendClientTurnEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "client/turn/requested",
        input: textInput("second question"),
        target: { kind: "new-turn" },
        execution,
        initiator: "user",
        senderThreadId: null,
        requestMethod: "turn/start",
        source: "tell",
      });
      expect(second.sequence).toBeGreaterThan(first.sequence);

      // what a restart sees: only the stored rows, no memory of this process
      const stored = loadFailedTurn(harness.db, thread.id);
      expect(stored).not.toBeNull();
      expect(stored?.requestSequence).toBe(second.sequence);
      expect(stored?.request.requestId).toBe(second.requestId);
      expect(JSON.stringify(stored?.request.input)).toContain("second question");
      expect(JSON.stringify(stored?.request.input)).not.toContain("first question");

      // another thread's request is not this thread's
      const other = seedThread(harness.deps, {
        projectId: thread.projectId,
        environmentId: environment.id,
      });
      expect(loadFailedTurn(harness.db, other.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("[sma:m_cd_reply] the frame a window gets for an appended event names the thread, the change and the event type and sequence, and carries none of the conversation words", async () => {
    const { environment, harness, thread } = await context();
    try {
      const socket = createMockHubSocket();
      harness.deps.hub.subscribe(socket, { kind: "thread-detail", threadId: thread.id });
      const words = "the confidential words of the conversation";
      const sequence = appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "system/error",
        scope: threadScope(),
        data: { message: words },
      });
      expect(socket.messages).toHaveLength(1);
      const frame = JSON.parse(socket.messages[0] as string) as Record<string, unknown>;
      expect(frame).toEqual({
        type: "changed",
        entity: "thread",
        id: thread.id,
        metadata: { eventTypes: ["system/error"], timelineSequence: sequence },
        changes: ["events-appended"],
      });
      expect(socket.messages[0]).not.toContain("confidential");

      // a window that did not subscribe to this thread is not sent a frame
      const stranger = createMockHubSocket();
      harness.deps.hub.subscribe(stranger, { kind: "thread-detail", threadId: "another-thread" });
      appendThreadEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        type: "system/error",
        scope: threadScope(),
        data: { message: words },
      });
      expect(stranger.messages).toEqual([]);
    } finally {
      await harness.cleanup();
    }
  });
});
