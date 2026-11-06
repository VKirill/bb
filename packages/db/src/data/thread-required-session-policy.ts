import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  VK_REQUIRED_SESSION_POLICY_PLUGIN_ID,
  assertVkRequiredPolicyProvider,
  intersectVkSessionPolicies,
  vkRequiredSessionPolicySchema,
  vkSessionPolicySchema,
  type VkRequiredSessionPolicy,
  type VkSessionPolicy,
} from "@bb/domain/vk-session-policy";
import type { VkCompiledMainAgent } from "@bb/domain/vk-compiled-main-agent";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import { threadPluginMetadata } from "../schema.js";
import { VK_REQUIRED_SESSION_POLICY_MARKER_ID, readVkThreadMarker, writeVkThreadMarker } from "./vk-thread-marker.js";
import { readVkCompiledMainAgentSnapshot } from "./thread-plugin-metadata.js";

// VK EXPERIMENTAL: `policy` is what the thread's own session loads; `ceiling` is what its children
// inherit. They differ only on a compiled-MAIN-agent thread: the agent's own skill/MCP selection narrows
// that session but is a working set, not a ceiling, so it is kept out of `ceiling`. Rows written before
// `ceiling` existed have only `policy`; vkSessionPolicyCeiling resolves them.
const vkStoredSessionPolicySchema = vkRequiredSessionPolicySchema.extend({
  ceiling: vkSessionPolicySchema.optional(),
}).strict();
export interface VkStoredSessionPolicy extends VkRequiredSessionPolicy {
  ceiling?: VkSessionPolicy;
}

// VK EXPERIMENTAL: the part of a stored policy a child inherits. A pre-`ceiling` row of a compiled-MAIN
// parent holds the explicit request intersected with the agent's own selection, and the two can no longer
// be told apart. For such a parent a group filter counts as agent-derived — and is left out — only when
// every clause stays inside the agent's stored selection: it then cannot carry an explicit restriction the
// agent did not already allow. An allow clause with zero names is never treated as agent-derived — it is
// an explicit "nothing" ceiling (`[].every` would pass vacuously). Everything else (deny clauses, names
// outside the agent's lists, the other groups and the switches) still narrows children, so a legacy row
// errs toward restricting, never toward widening past the stored ceiling.
// ponytail: the legacy heuristic cannot tell the agent's working set from an owner ceiling that happens to
// equal it (it may free an explicit restriction inside that set, never anything wider). New rows carry
// `ceiling`; drop the heuristic once no legacy compiled rows remain.
export function vkSessionPolicyCeiling(
  snapshot: VkStoredSessionPolicy,
  compiledAgentProfile: Pick<VkCompiledMainAgent, "skills" | "mcpServers"> | null,
): VkSessionPolicy {
  if (snapshot.ceiling !== undefined) return snapshot.ceiling;
  const policy = snapshot.policy;
  if (compiledAgentProfile === null) return policy;
  const ceiling: VkSessionPolicy = { ...policy };
  for (const key of ["skills", "mcpServers"] as const) {
    const allowed = compiledAgentProfile[key];
    const filter = ceiling[key];
    if (filter === undefined || allowed === undefined || filter.mode !== "allow") continue;
    const clauses = [{ mode: filter.mode, names: filter.names }, ...(filter.allOf ?? [])];
    if (clauses.every((clause) => clause.mode === "allow" && clause.names.length > 0 && clause.names.every((name) => allowed.includes(name)))) {
      delete ceiling[key];
    }
  }
  return ceiling;
}

export function vkRequiredSessionPolicyDigest(snapshot: VkStoredSessionPolicy): string {
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
  const parsed = vkStoredSessionPolicySchema.parse(snapshot);
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(parsed)))
    .digest("hex");
}

export function readVkRequiredSessionPolicy(db: DbQueryConnection, threadId: string): VkStoredSessionPolicy | null {
  const marker = readVkThreadMarker(db, threadId, VK_REQUIRED_SESSION_POLICY_MARKER_ID);
  const row = db.select().from(threadPluginMetadata).where(and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_PLUGIN_ID),
  )).get();
  if (!marker && !row) return null;
  if (!marker || !row) throw new Error("vk_required_session_policy_dropped");
  const snapshot = vkStoredSessionPolicySchema.parse(JSON.parse(row.metadataJson));
  if (vkRequiredSessionPolicyDigest(snapshot) !== marker.snapshotDigest) throw new Error("vk_required_session_policy_digest_mismatch");
  return snapshot;
}

export function insertVkRequiredSessionPolicy(db: DbTransaction, args: {
  threadId: string;
  providerId: string;
  requested?: VkRequiredSessionPolicy;
  /** VK EXPERIMENTAL: narrows this thread's own session only; it never enters the ceiling children inherit. */
  agentPolicy?: VkSessionPolicy;
  parentIds: readonly string[];
}): void {
  const inherited = [...new Set(args.parentIds)].flatMap((id) => {
    const snapshot = readVkRequiredSessionPolicy(db, id);
    if (snapshot === null) return [];
    const agent = readVkCompiledMainAgentSnapshot(db, id);
    return [vkSessionPolicyCeiling(snapshot, agent.required ? agent.profile : null)];
  });
  const requested = args.requested === undefined ? null : vkRequiredSessionPolicySchema.parse(args.requested);
  if (requested === null && inherited.length === 0 && args.agentPolicy === undefined) return;
  const ceiling = intersectVkSessionPolicies([...inherited, ...(requested ? [requested.policy] : [])]);
  const intersected = args.agentPolicy === undefined
    ? ceiling
    : intersectVkSessionPolicies([ceiling, args.agentPolicy]);
  // VK EXPERIMENTAL: claude.ai sync exists only in Claude Code. A parent's «sync off» is already true for any
  // other provider, so a codex or ACP child inherits the rest of the ceiling instead of being refused.
  if (args.providerId !== "claude-code" && intersected.claudeAiSync === false) delete intersected.claudeAiSync;
  const snapshot: VkStoredSessionPolicy = { version: 1, policy: intersected };
  if (args.agentPolicy !== undefined) snapshot.ceiling = ceiling;
  assertVkRequiredPolicyProvider(args.providerId, snapshot.policy);
  writeVkThreadMarker(db, args.threadId, VK_REQUIRED_SESSION_POLICY_MARKER_ID, { snapshotDigest: vkRequiredSessionPolicyDigest(snapshot) });
  db.insert(threadPluginMetadata).values({
    threadId: args.threadId,
    pluginId: VK_REQUIRED_SESSION_POLICY_PLUGIN_ID,
    metadataJson: JSON.stringify(snapshot),
  }).run();
}

export function narrowVkRequiredSessionPolicy(db: import("../connection.js").DbConnection, threadId: string, policy: import("@bb/domain/vk-session-policy").VkSessionPolicy): VkStoredSessionPolicy {
  return db.transaction((tx) => {
    const current = readVkRequiredSessionPolicy(tx, threadId);
    if (!current) throw new Error("vk_required_session_policy_dropped");
    const snapshot: VkStoredSessionPolicy = {
      version: 1,
      policy: intersectVkSessionPolicies([current.policy, policy]),
      ...(current.ceiling === undefined
        ? {}
        : { ceiling: intersectVkSessionPolicies([current.ceiling, policy]) }),
    };
    writeVkThreadMarker(tx, threadId, VK_REQUIRED_SESSION_POLICY_MARKER_ID, { snapshotDigest: vkRequiredSessionPolicyDigest(snapshot) });
    tx.update(threadPluginMetadata).set({ metadataJson: JSON.stringify(snapshot) }).where(and(
      eq(threadPluginMetadata.threadId, threadId),
      eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_PLUGIN_ID),
    )).run();
    return snapshot;
  }, { behavior: "immediate" });
}
