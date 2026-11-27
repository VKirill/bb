// VK EXPERIMENTAL (thread-instructions): `threads.experimental_vkThreadInstructions` — read the instructions
// core recorded for a public thread (packages/db/src/data/vk-thread-instructions.ts). Instance-wide like the
// other thread reads: any loaded plugin may read any public thread.
import { readVkThreadInstructions, type DbConnection } from "@bb/db";
import type { ExperimentalVkThreadInstructions } from "@get-bb/plugin-sdk";
import { requirePublicThread } from "../lib/entity-lookup.js";

export function createVkThreadInstructionsMethods(input: {
  db: DbConnection;
  assertLive: () => void;
}) {
  const { db, assertLive } = input;
  return {
    async experimental_vkThreadInstructions(
      threadId: string,
    ): Promise<ExperimentalVkThreadInstructions | null> {
      assertLive();
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new Error("experimental_vkThreadInstructions threadId must be a non-empty string");
      }
      requirePublicThread(db, threadId);
      return readVkThreadInstructions(db, threadId);
    },
  };
}
