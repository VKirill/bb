import { and, desc, eq } from "drizzle-orm";
import { events } from "@bb/db";
import type { DbQueryConnection } from "@bb/db";

export type VkIdleTurn = { turnId: string | null; isSubAgent: boolean };

// VK EXPERIMENTAL: the last completed turn behind a thread.idle event —
// its turn id and whether it was a nested (sub-agent) turn.
export function vkLastCompletedTurn(db: DbQueryConnection, threadId: string): VkIdleTurn | null {
  const row = db
    .select({ turnId: events.turnId, parentToolCallId: events.parentToolCallId })
    .from(events)
    .where(and(eq(events.threadId, threadId), eq(events.type, "turn/completed")))
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!row || row.turnId === null) return null;
  return { turnId: row.turnId, isSubAgent: row.parentToolCallId !== null };
}
