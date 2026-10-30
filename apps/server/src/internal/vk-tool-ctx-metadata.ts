import { getThreadPluginMetadata } from "@bb/db";
import type { AppDeps } from "../types.js";

// VK EXPERIMENTAL: the calling plugin's own thread metadata, handed to the tool's ctx.
export function vkToolContextPluginMetadata(
  deps: AppDeps,
  args: { threadId: string; pluginId: string },
): Record<string, unknown> | null {
  const read = getThreadPluginMetadata(deps.db, args.threadId, args.pluginId);
  const metadata = read.metadata;
  return metadata && Object.keys(metadata).length > 0 ? metadata : null;
}
