// VK EXPERIMENTAL: launch tuning of one thread (see @bb/domain/vk-launch-tuning). A plugin that starts a helper
// narrows how its agent is launched by putting `experimental_vkLaunchTuning` into the plugin metadata it passes on
// spawn. No table and no migration: the value lives in the plugin's own metadata row, which BB already stores.
import { eq } from "drizzle-orm";
import {
  VK_LAUNCH_TUNING_METADATA_KEY,
  parseVkLaunchTuning,
  type VkLaunchTuning,
} from "@bb/domain/vk-launch-tuning";
import type { DbQueryConnection } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";

/**
 * The thread's launch tuning, or null: none set, an invalid value, or any read failure. A read failure must never
 * stop a thread from starting, it only leaves the launch as it was. The first valid row wins.
 */
export function readVkLaunchTuningForThread(
  db: DbQueryConnection,
  threadId: string,
): VkLaunchTuning | null {
  let rows: Array<{ metadataJson: string }>;
  try {
    rows = db
      .select({ metadataJson: threadPluginMetadata.metadataJson })
      .from(threadPluginMetadata)
      .where(eq(threadPluginMetadata.threadId, threadId))
      .all();
  } catch {
    return null;
  }
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.metadataJson);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const tuning = parseVkLaunchTuning(
        (parsed as Record<string, unknown>)[VK_LAUNCH_TUNING_METADATA_KEY],
      );
      if (tuning !== null) return tuning;
    } catch {
      continue;
    }
  }
  return null;
}
