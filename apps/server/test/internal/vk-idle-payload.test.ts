import { createThread, events, noopNotifier } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { vkLastCompletedTurn } from "../../src/services/plugins/vk-idle-payload.js";

function insertEvent(db: ReturnType<typeof createMigratedConnection>, args: { threadId: string; sequence: number; turnId: string | null; parentToolCallId?: string | null; type?: string }) {
  db.insert(events).values({
    id: `ev-${args.threadId}-${args.sequence}`,
    threadId: args.threadId,
    scopeKind: args.turnId ? "turn" : "thread",
    turnId: args.turnId,
    sequence: args.sequence,
    type: (args.type ?? "turn/completed") as never,
    parentToolCallId: args.parentToolCallId ?? null,
    data: "{}",
    createdAt: Date.now(),
  }).run();
}

describe("vkLastCompletedTurn", () => {
  it("returns the newest completed turn, flags a sub-agent turn, and is null without one", () => {
    const db = createMigratedConnection();
    const thread = createThread(db, noopNotifier, { projectId: PERSONAL_PROJECT_ID, providerId: "codex" });
    insertEvent(db, { threadId: thread.id, sequence: 1, turnId: "turn-1" });
    insertEvent(db, { threadId: thread.id, sequence: 2, turnId: "turn-2", parentToolCallId: "call_9" });
    insertEvent(db, { threadId: thread.id, sequence: 3, turnId: null, type: "item/completed" });
    expect(vkLastCompletedTurn(db, thread.id)).toEqual({ turnId: "turn-2", isSubAgent: true });
    const empty = createThread(db, noopNotifier, { projectId: PERSONAL_PROJECT_ID, providerId: "codex" });
    expect(vkLastCompletedTurn(db, empty.id)).toBeNull();
  });
});
