// VK EXPERIMENTAL: a child that has just told its parent itself (`bb thread tell` → a turn request in the parent whose
// senderThreadId is the child) gets no «completed» notice on top: the parent was woken twice for one result (12 of 80
// completion notices on the hub, 2026-10-21..23). Only a message in the last two minutes of the child's turn counts — a progress
// note earlier in the turn is not its result — and only «completed» is skipped; a failed or interrupted turn is still told.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { events } from "../schema.js";

export const VK_CHILD_TOLD_PARENT_WINDOW_MS = 120_000;

/** False when anything goes wrong: a read failure must never swallow a parent's notification. */
export function vkChildJustToldParent(db: DbQueryConnection, childThreadId: string, parentThreadId: string, now = Date.now()): boolean {
  try {
    const started = db.select({ at: events.createdAt }).from(events)
      .where(and(eq(events.threadId, childThreadId), eq(events.type, "turn/started" as never)))
      .orderBy(desc(events.sequence)).limit(1).get();
    const since = Math.max(started?.at ?? 0, now - VK_CHILD_TOLD_PARENT_WINDOW_MS);
    const told = db.select({ id: events.id }).from(events)
      .where(and(eq(events.threadId, parentThreadId), eq(events.type, "client/turn/requested" as never), gte(events.createdAt, since),
        sql`json_extract(${events.data}, '$.senderThreadId') = ${childThreadId}`))
      .limit(1).get();
    return Boolean(told);
  } catch {
    return false;
  }
}
