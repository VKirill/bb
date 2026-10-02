import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  VK_REQUIRED_SESSION_POLICY_PLUGIN_ID,
  assertVkRequiredPolicyProvider,
  intersectVkSessionPolicies,
  vkRequiredSessionPolicySchema,
  type VkRequiredSessionPolicy,
} from "@bb/domain/vk-session-policy";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";
import { VK_REQUIRED_SESSION_POLICY_MARKER_ID, readVkThreadMarker, writeVkThreadMarker } from "./vk-thread-marker.js";

function digest(snapshot: VkRequiredSessionPolicy): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };
  const parsed = vkRequiredSessionPolicySchema.parse(snapshot);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(parsed)))
    .digest("hex");
}

export function readVkRequiredSessionPolicy(db: DbQueryConnection, threadId: string): VkRequiredSessionPolicy | null {
  const marker = readVkThreadMarker(db, threadId, VK_REQUIRED_SESSION_POLICY_MARKER_ID);
  const row = db.select().from(threadPluginMetadata).where(and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_PLUGIN_ID),
  )).get();
  if (!marker && !row) return null;
  if (!marker || !row) throw new Error("vk_required_session_policy_dropped");
  const snapshot = vkRequiredSessionPolicySchema.parse(JSON.parse(row.metadataJson));
  if (digest(snapshot) !== marker.snapshotDigest) throw new Error("vk_required_session_policy_digest_mismatch");
  return snapshot;
}

export function insertVkRequiredSessionPolicy(db: DbTransaction, args: {
  threadId: string;
  providerId: string;
  requested?: VkRequiredSessionPolicy;
  parentIds: readonly string[];
}): void {
  const inherited = [...new Set(args.parentIds)].flatMap((id) => {
    const snapshot = readVkRequiredSessionPolicy(db, id);
    return snapshot ? [snapshot.policy] : [];
  });
  if (args.requested === undefined && inherited.length === 0) return;
  const requested = args.requested === undefined ? null : vkRequiredSessionPolicySchema.parse(args.requested);
  const intersected = intersectVkSessionPolicies([...inherited, ...(requested ? [requested.policy] : [])]);
  // VK EXPERIMENTAL: claude.ai sync exists only in Claude Code. A parent's «sync off» is already true for any
  // other provider, so a codex or ACP child inherits the rest of the ceiling instead of being refused.
  if (args.providerId !== "claude-code" && intersected.claudeAiSync === false) delete intersected.claudeAiSync;
  const snapshot: VkRequiredSessionPolicy = { version: 1, policy: intersected };
  assertVkRequiredPolicyProvider(args.providerId, snapshot.policy);
  writeVkThreadMarker(db, args.threadId, VK_REQUIRED_SESSION_POLICY_MARKER_ID, { snapshotDigest: digest(snapshot) });
  db.insert(threadPluginMetadata).values({
    threadId: args.threadId,
    pluginId: VK_REQUIRED_SESSION_POLICY_PLUGIN_ID,
    metadataJson: JSON.stringify(snapshot),
  }).run();
}

export function narrowVkRequiredSessionPolicy(db: import("../connection.js").DbConnection, threadId: string, policy: import("@bb/domain/vk-session-policy").VkSessionPolicy): VkRequiredSessionPolicy {
  return db.transaction((tx) => {
    const current = readVkRequiredSessionPolicy(tx, threadId);
    if (!current) throw new Error("vk_required_session_policy_dropped");
    const snapshot: VkRequiredSessionPolicy = { version: 1, policy: intersectVkSessionPolicies([current.policy, policy]) };
    writeVkThreadMarker(tx, threadId, VK_REQUIRED_SESSION_POLICY_MARKER_ID, { snapshotDigest: digest(snapshot) });
    tx.update(threadPluginMetadata).set({ metadataJson: JSON.stringify(snapshot) }).where(and(
      eq(threadPluginMetadata.threadId, threadId),
      eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_PLUGIN_ID),
    )).run();
    return snapshot;
  }, { behavior: "immediate" });
}
