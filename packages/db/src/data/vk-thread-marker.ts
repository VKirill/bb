// VK EXPERIMENTAL: required markers for VK thread snapshots, kept as reserved rows of thread plugin metadata.
// The VK layer adds no tables or migrations (official migrations change every release); a marker row
// beside the snapshot row lets core tell a dropped snapshot from a thread that never had one.
import { and, eq } from "drizzle-orm";
import type { DbQueryConnection, DbTransaction, DbConnection } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";

export const VK_REQUIRED_SESSION_POLICY_MARKER_ID = "__vk.required-session-policy.marker";
export const VK_COMPILED_MAIN_AGENT_MARKER_ID = "__vk.compiled-main-agent.marker";

export function readVkThreadMarker(
  db: DbQueryConnection,
  threadId: string,
  markerId: string,
): Record<string, string> | undefined {
  const row = db.select().from(threadPluginMetadata).where(and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, markerId),
  )).get();
  if (!row) return undefined;
  const parsed = JSON.parse(row.metadataJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("vk_thread_marker_corrupt");
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
}

export function writeVkThreadMarker(
  db: DbConnection | DbTransaction,
  threadId: string,
  markerId: string,
  values: Record<string, string>,
): void {
  const metadataJson = JSON.stringify(values);
  const existing = readVkThreadMarker(db, threadId, markerId);
  if (existing) {
    db.update(threadPluginMetadata).set({ metadataJson }).where(and(
      eq(threadPluginMetadata.threadId, threadId),
      eq(threadPluginMetadata.pluginId, markerId),
    )).run();
    return;
  }
  db.insert(threadPluginMetadata).values({ threadId, pluginId: markerId, metadataJson }).run();
}
