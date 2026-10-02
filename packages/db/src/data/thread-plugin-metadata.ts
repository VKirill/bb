import { VK_REQUIRED_SESSION_POLICY_METADATA_KEY } from "@bb/domain/vk-session-policy";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  exceedsPluginMetadataLimit,
  parsePersistedPluginMetadata,
  type JsonObject,
} from "@bb/domain";
import {
  VK_COMPILED_MAIN_AGENT_METADATA_KEY,
  VK_COMPILED_MAIN_AGENT_PLUGIN_ID,
  mutableMetadataTouchesCompiledAgent,
  parseVkCompiledMainAgent,
  type VkCompiledMainAgent,
} from "@bb/domain/vk-compiled-main-agent";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  threadPluginMetadata,
} from "../schema.js";
import { VK_COMPILED_MAIN_AGENT_MARKER_ID, readVkThreadMarker, writeVkThreadMarker } from "./vk-thread-marker.js";

export interface ThreadPluginMetadataPatch {
  threadId: string;
  pluginId: string;
  set: JsonObject;
  remove: readonly string[];
}

export interface ThreadPluginMetadataRead {
  metadata: JsonObject;
  corrupt: boolean;
}

export type ThreadPluginMetadataPatchResult =
  | { ok: true; metadata: JsonObject; replacedCorrupt: boolean }
  | { ok: false; reason: "too_large" | "reserved_key" | "corrupt_reserved" };

function namespaceWhere(threadId: string, pluginId: string) {
  return and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, pluginId),
  );
}

export function getThreadPluginMetadata(
  db: DbQueryConnection,
  threadId: string,
  pluginId: string,
): ThreadPluginMetadataRead {
  const row = db
    .select({ metadataJson: threadPluginMetadata.metadataJson })
    .from(threadPluginMetadata)
    .where(namespaceWhere(threadId, pluginId))
    .get();
  if (row === undefined) return { metadata: {}, corrupt: false };
  const metadata = parsePersistedPluginMetadata(row.metadataJson);
  return metadata === undefined
    ? { metadata: {}, corrupt: true }
    : { metadata, corrupt: false };
}

export function listThreadPluginMetadataRows(
  db: DbQueryConnection,
  threadId: string,
  pluginIds: readonly string[],
): Array<{ pluginId: string; metadataJson: string }> {
  if (pluginIds.length === 0) return [];
  return db
    .select({
      pluginId: threadPluginMetadata.pluginId,
      metadataJson: threadPluginMetadata.metadataJson,
    })
    .from(threadPluginMetadata)
    .where(
      and(
        eq(threadPluginMetadata.threadId, threadId),
        inArray(threadPluginMetadata.pluginId, [...pluginIds]),
      ),
    )
    .all();
}

export function insertThreadPluginMetadata(
  db: DbConnection | DbTransaction,
  input: { threadId: string; pluginId: string; metadata: JsonObject },
): void {
  if (
    mutableMetadataTouchesCompiledAgent(input.metadata, input.pluginId)
  ) {
    throw new Error("vk_compiled_main_agent_reserved_key");
  }
  db.insert(threadPluginMetadata)
    .values({
      threadId: input.threadId,
      pluginId: input.pluginId,
      metadataJson: JSON.stringify(input.metadata),
    })
    .run();
}

export function digestVkCompiledMainAgentSource(
  profile: Omit<VkCompiledMainAgent, "sourceHash">,
): string {
  const ordered = {
    id: profile.id,
    sourceVersion: profile.sourceVersion,
    description: profile.description,
    prompt: profile.prompt,
    ...(profile.tools ? { tools: profile.tools } : {}),
    ...(profile.disallowedTools ? { disallowedTools: profile.disallowedTools } : {}),
    ...(profile.skills ? { skills: profile.skills } : {}),
    ...(profile.mcpServers ? { mcpServers: profile.mcpServers } : {}),
  };
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonical(nested)]),
      );
    }
    return value;
  };
  const serialized = profile.sourceVersion === "lp-owned-1"
    ? JSON.stringify(ordered)
    : JSON.stringify(canonical(ordered));
  return createHash("sha256").update(serialized).digest("hex");
}

export function digestVkCompiledMainAgent(profile: VkCompiledMainAgent): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: profile.id,
        sourceVersion: profile.sourceVersion,
        sourceHash: profile.sourceHash,
        description: profile.description,
        prompt: profile.prompt,
        tools: profile.tools ?? null,
        disallowedTools: profile.disallowedTools ?? null,
        skills: profile.skills ?? null,
        mcpServers: profile.mcpServers ?? null,
      }),
    )
    .digest("hex");
}

export function insertVkCompiledMainAgentSnapshot(
  db: DbConnection | DbTransaction,
  input: { threadId: string; profile: VkCompiledMainAgent },
): void {
  const snapshot = parseVkCompiledMainAgent(input.profile);
  if (snapshot === null) {
    throw new Error("vk_compiled_main_agent_incomplete");
  }
  const { sourceHash, ...sourceBody } = snapshot;
  if (digestVkCompiledMainAgentSource(sourceBody) !== sourceHash) {
    throw new Error("vk_compiled_main_agent_source_hash_mismatch");
  }
  writeVkThreadMarker(db, input.threadId, VK_COMPILED_MAIN_AGENT_MARKER_ID, {
    sourceHash: snapshot.sourceHash,
    snapshotDigest: digestVkCompiledMainAgent(snapshot),
  });
  db.insert(threadPluginMetadata)
    .values({
      threadId: input.threadId,
      pluginId: VK_COMPILED_MAIN_AGENT_PLUGIN_ID,
      metadataJson: JSON.stringify({
        required: true,
        snapshot,
      }),
    })
    .run();
}

export function readVkCompiledMainAgentSnapshot(
  db: DbQueryConnection,
  threadId: string,
):
  | { required: false; profile: null }
  | { required: true; profile: VkCompiledMainAgent } {
  const required = readVkThreadMarker(db, threadId, VK_COMPILED_MAIN_AGENT_MARKER_ID);
  const stored = getThreadPluginMetadata(
    db,
    threadId,
    VK_COMPILED_MAIN_AGENT_PLUGIN_ID,
  );
  if (stored.corrupt) {
    throw new Error("vk_compiled_main_agent_dropped");
  }
  const snapshotMissing = Object.keys(stored.metadata).length === 0;
  if (required === undefined && snapshotMissing) {
    return { required: false, profile: null };
  }
  if (required === undefined || snapshotMissing) {
    throw new Error("vk_compiled_main_agent_dropped");
  }
  if (stored.metadata.required !== true || stored.metadata.snapshot === undefined) {
    throw new Error("vk_compiled_main_agent_dropped");
  }
  const profile = parseVkCompiledMainAgent(stored.metadata.snapshot);
  if (profile === null) throw new Error("vk_compiled_main_agent_dropped");
  const { sourceHash, ...sourceBody } = profile;
  if (
    sourceHash !== required.sourceHash ||
    digestVkCompiledMainAgentSource(sourceBody) !== sourceHash ||
    required.snapshotDigest !== digestVkCompiledMainAgent(profile)
  ) {
    throw new Error("vk_compiled_main_agent_dropped");
  }
  return { required: true, profile };
}

export function patchThreadPluginMetadata(
  db: DbConnection,
  input: ThreadPluginMetadataPatch,
): ThreadPluginMetadataPatchResult {
  return db.transaction(
    (tx) => {
      const existing = getThreadPluginMetadata(
        tx,
        input.threadId,
        input.pluginId,
      );
      const reservedTouch =
        mutableMetadataTouchesCompiledAgent(input.set, input.pluginId) ||
        input.remove.includes(VK_COMPILED_MAIN_AGENT_METADATA_KEY) ||
        input.remove.includes(VK_REQUIRED_SESSION_POLICY_METADATA_KEY) ||
        input.pluginId === VK_COMPILED_MAIN_AGENT_PLUGIN_ID;
      if (reservedTouch) {
        return {
          ok: false,
          reason: existing.corrupt ? "corrupt_reserved" : "reserved_key",
        };
      }
      const metadata: JsonObject = { ...existing.metadata, ...input.set };
      for (const key of input.remove) delete metadata[key];
      if (Object.keys(metadata).length === 0) {
        tx.delete(threadPluginMetadata)
          .where(namespaceWhere(input.threadId, input.pluginId))
          .run();
        return { ok: true, metadata, replacedCorrupt: existing.corrupt };
      }
      const metadataJson = JSON.stringify(metadata);
      if (exceedsPluginMetadataLimit(metadataJson)) {
        return { ok: false, reason: "too_large" };
      }
      tx.insert(threadPluginMetadata)
        .values({
          threadId: input.threadId,
          pluginId: input.pluginId,
          metadataJson,
        })
        .onConflictDoUpdate({
          target: [
            threadPluginMetadata.threadId,
            threadPluginMetadata.pluginId,
          ],
          set: { metadataJson },
        })
        .run();
      return { ok: true, metadata, replacedCorrupt: existing.corrupt };
    },
    { behavior: "immediate" },
  );
}
