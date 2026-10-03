// VK EXPERIMENTAL: a quiet child thread — its turns do not wake the parent. A plugin that watches its own helper
// threads (Lane Pilot waits for writers, critics, readers, memory and docs itself) marks them with
// `experimental_vkQuietChild: true` in the plugin metadata it passes on spawn. Without this every finished helper
// sent its whole output into the parent agent as a new turn: 52 of them in one SelfyStudio PM chat, and an owner
// message that arrived in the same turn went unanswered. No table and no migration: the flag lives in the
// plugin's own metadata row, which BB already stores.
import { eq } from "drizzle-orm";
import type { DbQueryConnection } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";

export const VK_QUIET_CHILD_KEY = "experimental_vkQuietChild";

/** False when anything goes wrong: a read failure must never swallow a parent's notification. */
export function isVkQuietChildThread(db: DbQueryConnection, threadId: string): boolean {
  let rows: Array<{ metadataJson: string }>;
  try {
    rows = db
      .select({ metadataJson: threadPluginMetadata.metadataJson })
      .from(threadPluginMetadata)
      .where(eq(threadPluginMetadata.threadId, threadId))
      .all();
  } catch {
    return false;
  }
  return rows.some((row) => {
    try {
      const parsed: unknown = JSON.parse(row.metadataJson);
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>)[VK_QUIET_CHILD_KEY] === true);
    } catch {
      return false;
    }
  });
}
