// VK EXPERIMENTAL: idempotent spawn and own-metadata lookup on `bb.sdk.threads` (see packages/db/src/data/vk-thread-keys.ts).
import {
  VK_FIND_BY_METADATA_MAX_LIMIT,
  findVkThreadIdByKey,
  findVkThreadIdsByPluginMetadata,
  isValidVkThreadKey,
  type DbConnection,
} from "@bb/db";
import type { BbSdk, ThreadSpawnArgs } from "@bb/sdk";
import type { ThreadResponse } from "@bb/server-contract";
import type {
  ExperimentalVkFindByPluginMetadataArgs,
  ExperimentalVkSpawnKeyedArgs,
  ExperimentalVkSpawnKeyedResult,
} from "@get-bb/plugin-sdk";

const KEY_CONFLICT_CODE = "vk_thread_key_conflict";

function invalidKeyError(): Error {
  return new Error(
    "experimental_vkSpawnKeyed key must be a string of 1 to 200 characters",
  );
}

function isKeyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === KEY_CONFLICT_CODE
  );
}

export function createVkThreadKeyMethods(input: {
  db: DbConnection;
  pluginId: string;
  sdk: BbSdk;
  /** The plugin-attributed `threads.spawn` (sets origin and originPluginId). */
  spawn: (args: ThreadSpawnArgs) => Promise<ThreadResponse>;
}) {
  const { db, pluginId, sdk } = input;
  const load = async (threadId: string): Promise<ThreadResponse> =>
    (await sdk.threads.get({ threadId })) as ThreadResponse;

  return {
    async experimental_vkSpawnKeyed(
      args: ExperimentalVkSpawnKeyedArgs,
    ): Promise<ExperimentalVkSpawnKeyedResult> {
      const { key, ...spawnArgs } = args;
      if (!isValidVkThreadKey(key)) throw invalidKeyError();
      const held = findVkThreadIdByKey(db, pluginId, key);
      if (held !== null) return { thread: await load(held), reused: true };
      try {
        const thread = await input.spawn({
          ...spawnArgs,
          experimental_vkKey: key,
        } as ThreadSpawnArgs);
        return { thread, reused: false };
      } catch (error) {
        // Two spawns raced past the check above; the immediate transaction let one through.
        if (!isKeyConflict(error)) throw error;
        const winner = findVkThreadIdByKey(db, pluginId, key);
        if (winner === null) throw error;
        return { thread: await load(winner), reused: true };
      }
    },

    async experimental_vkFindByKey(
      key: string,
    ): Promise<ThreadResponse | null> {
      if (!isValidVkThreadKey(key)) throw invalidKeyError();
      const threadId = findVkThreadIdByKey(db, pluginId, key);
      return threadId === null ? null : load(threadId);
    },

    async experimental_vkFindByPluginMetadata(
      args: ExperimentalVkFindByPluginMetadataArgs,
    ): Promise<ThreadResponse[]> {
      const match = args?.match;
      if (
        match === null ||
        typeof match !== "object" ||
        Object.keys(match).length === 0 ||
        !Object.values(match).every(
          (value) =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean",
        )
      ) {
        throw new Error(
          "experimental_vkFindByPluginMetadata match must be a non-empty object of strings, numbers and booleans",
        );
      }
      const ids = findVkThreadIdsByPluginMetadata(db, {
        pluginId,
        match,
        ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
        ...(args.includeArchived === undefined
          ? {}
          : { includeArchived: args.includeArchived }),
        limit: Math.min(
          args.limit ?? VK_FIND_BY_METADATA_MAX_LIMIT,
          VK_FIND_BY_METADATA_MAX_LIMIT,
        ),
      });
      return Promise.all(ids.map(load));
    },
  };
}
