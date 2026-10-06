import type { ThreadSpawnArgs } from "@bb/sdk";
import type { ThreadResponse } from "@bb/server-contract";

/** VK extension. A flat match against the plugin's own thread metadata row. */
export type ExperimentalVkThreadMetadataMatch = Record<
  string,
  string | number | boolean
>;

/** `threads.spawn` arguments plus the idempotency key: a string of 1 to 200 characters, unique within the plugin. */
export type ExperimentalVkSpawnKeyedArgs = ThreadSpawnArgs & { key: string };

export interface ExperimentalVkSpawnKeyedResult {
  thread: ThreadResponse;
  /** True when a live thread of this plugin already held the key and no new thread was created. */
  reused: boolean;
}

export interface ExperimentalVkFindByPluginMetadataArgs {
  /** Every entry must equal the field in this plugin's own metadata row. Not empty. */
  match: ExperimentalVkThreadMetadataMatch;
  projectId?: string;
  includeArchived?: boolean;
  /** 1 to 100, default 100. Newest first. */
  limit?: number;
}

/**
 * The optional methods VK builds add to `bb.sdk.threads`. Feature-test each:
 * `typeof bb.sdk.threads.experimental_vkSpawnKeyed === "function"`.
 * Only this plugin's own threads are visible; a deleted thread never matches and frees its key.
 */
export interface ExperimentalVkThreadKeys {
  experimental_vkSpawnKeyed?(
    args: ExperimentalVkSpawnKeyedArgs,
  ): Promise<ExperimentalVkSpawnKeyedResult>;
  experimental_vkFindByKey?(key: string): Promise<ThreadResponse | null>;
  experimental_vkFindByPluginMetadata?(
    args: ExperimentalVkFindByPluginMetadataArgs,
  ): Promise<ThreadResponse[]>;
}
