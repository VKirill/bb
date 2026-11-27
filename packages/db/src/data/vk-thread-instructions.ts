// VK EXPERIMENTAL (thread-instructions): the exact instructions core sent to a thread's provider bridge,
// kept for debugging in a reserved row of thread plugin metadata (the VK layer adds no tables or migrations).
// `start` is the text of the latest `thread.start`; `latest` is the text of the latest turn whose instructions
// differed from it (a resumed or restarted session receives the turn's text).
import { and, eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";

export const VK_THREAD_INSTRUCTIONS_ROW_ID = "__vk.thread-instructions";

export interface VkThreadInstructionsSnapshot {
  text: string;
  capturedAt: number;
  providerId: string;
  model: string;
}

export interface VkThreadInstructionsRecord {
  start: VkThreadInstructionsSnapshot | null;
  latest: VkThreadInstructionsSnapshot | null;
}

function rowWhere(threadId: string) {
  return and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, VK_THREAD_INSTRUCTIONS_ROW_ID),
  );
}

function parseSnapshot(value: unknown): VkThreadInstructionsSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.text !== "string" ||
    typeof v.capturedAt !== "number" ||
    typeof v.providerId !== "string" ||
    typeof v.model !== "string"
  ) {
    return null;
  }
  return { text: v.text, capturedAt: v.capturedAt, providerId: v.providerId, model: v.model };
}

export function readVkThreadInstructions(
  db: DbQueryConnection,
  threadId: string,
): VkThreadInstructionsRecord | null {
  const row = db.select().from(threadPluginMetadata).where(rowWhere(threadId)).get();
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.metadataJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  return { start: parseSnapshot(record.start), latest: parseSnapshot(record.latest) };
}

export function recordVkThreadInstructions(
  db: DbConnection,
  threadId: string,
  kind: "start" | "turn",
  snapshot: VkThreadInstructionsSnapshot,
): void {
  const current = readVkThreadInstructions(db, threadId);
  let next: VkThreadInstructionsRecord;
  if (kind === "start") {
    next = { start: snapshot, latest: null };
  } else {
    const effective = current?.latest ?? current?.start ?? null;
    // Every turn re-resolves the same text; write only when it changed.
    if (effective?.text === snapshot.text) return;
    next = { start: current?.start ?? null, latest: snapshot };
  }
  const metadataJson = JSON.stringify(next);
  const exists = db.select({ threadId: threadPluginMetadata.threadId }).from(threadPluginMetadata).where(rowWhere(threadId)).get();
  if (exists) {
    db.update(threadPluginMetadata).set({ metadataJson }).where(rowWhere(threadId)).run();
    return;
  }
  db.insert(threadPluginMetadata)
    .values({ threadId, pluginId: VK_THREAD_INSTRUCTIONS_ROW_ID, metadataJson })
    .run();
}
