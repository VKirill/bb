// VK EXPERIMENTAL: idempotent thread keys and metadata lookup for plugins. A plugin that lost the answer to
// `threads.spawn` used to page through every thread to find its own (1000+ threads in one project: page_cap).
// The key lives in the reserved field `__vk.key` of the spawning plugin's own `thread_plugin_metadata` row,
// next to whatever else that plugin stores there. No table, no migration: the check and the insert run in the
// same immediate transaction as the thread row (see createThread), so two spawns with one key make one thread.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { JsonObject } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { threadPluginMetadata, threads } from "../schema.js";

export const VK_THREAD_KEY_METADATA_KEY = "__vk.key";
export const VK_THREAD_KEY_MAX_LENGTH = 200;
export const VK_FIND_BY_METADATA_MAX_LIMIT = 100;

export type VkThreadMetadataMatch = Record<string, string | number | boolean>;

/** A live thread of the same plugin already holds the key. */
export class VkThreadKeyConflictError extends Error {
  constructor(
    readonly pluginId: string,
    readonly threadId: string,
  ) {
    super(`vk_thread_key_conflict:${threadId}`);
    this.name = "VkThreadKeyConflictError";
  }
}

export function isValidVkThreadKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= VK_THREAD_KEY_MAX_LENGTH
  );
}

const keyPath = `$."${VK_THREAD_KEY_METADATA_KEY}"`;

/** The non-deleted thread of this plugin that holds the key, or null. Archived threads still hold it. */
export function findVkThreadIdByKey(
  db: DbQueryConnection,
  pluginId: string,
  key: string,
): string | null {
  const row = db
    .select({ threadId: threadPluginMetadata.threadId })
    .from(threadPluginMetadata)
    .innerJoin(threads, eq(threads.id, threadPluginMetadata.threadId))
    .where(
      and(
        eq(threadPluginMetadata.pluginId, pluginId),
        sql`json_extract(${threadPluginMetadata.metadataJson}, ${keyPath}) = ${key}`,
        isNull(threads.deletedAt),
      ),
    )
    .limit(1)
    .get();
  return row?.threadId ?? null;
}

/** Throws VkThreadKeyConflictError when the key is taken. Call inside the thread-create transaction. */
export function assertVkThreadKeyFree(
  db: DbQueryConnection,
  pluginId: string,
  key: string,
): void {
  const holder = findVkThreadIdByKey(db, pluginId, key);
  if (holder !== null) throw new VkThreadKeyConflictError(pluginId, holder);
}

/** Thread ids of this plugin's own metadata rows whose every `match` entry is equal, newest first. */
export function findVkThreadIdsByPluginMetadata(
  db: DbQueryConnection,
  input: {
    pluginId: string;
    match: VkThreadMetadataMatch;
    projectId?: string;
    includeArchived?: boolean;
    limit?: number;
  },
): string[] {
  const entries = Object.entries(input.match);
  if (entries.length === 0) {
    throw new Error("vk_find_by_metadata_empty_match");
  }
  if (entries.some(([field]) => /["\\]/.test(field))) {
    throw new Error("vk_find_by_metadata_bad_field");
  }
  const limit = Math.min(
    Math.max(1, Math.trunc(input.limit ?? VK_FIND_BY_METADATA_MAX_LIMIT)),
    VK_FIND_BY_METADATA_MAX_LIMIT,
  );
  const conditions = [
    eq(threadPluginMetadata.pluginId, input.pluginId),
    isNull(threads.deletedAt),
    ...entries.map(([field, value]) => {
      const path = `$.${JSON.stringify(field)}`;
      // json_extract yields 1/0 for JSON booleans, text for strings, numbers for numbers.
      const bound = typeof value === "boolean" ? (value ? 1 : 0) : value;
      return sql`json_extract(${threadPluginMetadata.metadataJson}, ${path}) = ${bound}`;
    }),
    ...(input.includeArchived === true ? [] : [isNull(threads.archivedAt)]),
    ...(input.projectId === undefined
      ? []
      : [eq(threads.projectId, input.projectId)]),
  ];
  return db
    .select({ threadId: threadPluginMetadata.threadId })
    .from(threadPluginMetadata)
    .innerJoin(threads, eq(threads.id, threadPluginMetadata.threadId))
    .where(and(...conditions))
    .orderBy(sql`${threads.createdAt} desc`, sql`${threads.id} desc`)
    .limit(limit)
    .all()
    .map((row) => row.threadId);
}

/**
 * The plugin metadata rows a new thread is seeded with. Without a key this is exactly the caller's seed
 * (nothing when it is empty); with a key the reserved field is added to the same plugin's row.
 */
export function vkThreadMetadataRows(
  seed: { pluginId: string; metadata: JsonObject } | null | undefined,
  vkKey: { pluginId: string; key: string } | undefined,
): Array<{ pluginId: string; metadata: JsonObject }> {
  const rows: Array<{ pluginId: string; metadata: JsonObject }> = [];
  if (seed && Object.keys(seed.metadata).length > 0) rows.push(seed);
  if (vkKey === undefined) return rows;
  const index = rows.findIndex((row) => row.pluginId === vkKey.pluginId);
  if (index >= 0) {
    rows[index] = {
      pluginId: vkKey.pluginId,
      metadata: {
        ...rows[index]!.metadata,
        [VK_THREAD_KEY_METADATA_KEY]: vkKey.key,
      },
    };
  } else {
    rows.push({
      pluginId: vkKey.pluginId,
      metadata: { [VK_THREAD_KEY_METADATA_KEY]: vkKey.key },
    });
  }
  return rows;
}
