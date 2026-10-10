import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  getThreadPluginMetadata,
  insertThreadPluginMetadata,
  type DbConnection,
  type DbTransaction,
} from "@bb/db";
import type { JsonObject } from "@bb/domain";
import type { HostDaemonInjectedSkillSource } from "@bb/host-daemon-contract";
import {
  ISOLATED_SKILL_DELIVERY_METADATA_PLUGIN_ID,
  isReservedIsolatedSkillDeliveryPluginId,
  parsePersistedIsolatedSkillDeliveryPolicy,
  pickIsolatedContextAllowlist,
  type IsolatedSkillDeliveryRequestFields,
  type PersistedIsolatedSkillDeliveryPolicy,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { ResolvedSkillCatalogEntry } from "../skills/injected-skills.js";
import type { AppDeps } from "../../types.js";

export interface IsolatedSkillRoot {
  id: string;
  path: string;
  source: HostDaemonInjectedSkillSource;
}

export interface IsolatedSkillDeliveryContext {
  isolatedSkillDelivery: true;
  skillIds: readonly string[];
  isolatedSkillRoots: readonly IsolatedSkillRoot[];
  hostId?: string;
  allowBridgeToolProxy?: boolean;
}

export { assertWritablePluginMetadataNamespace } from "./caller-launch.js";

export function requestIsolatedSkillDeliveryPolicy(
  request: IsolatedSkillDeliveryRequestFields & {
    originPluginId?: string;
    hostId?: string;
  },
): PersistedIsolatedSkillDeliveryPolicy | null {
  if (
    request.originPluginId !== undefined &&
    isReservedIsolatedSkillDeliveryPluginId(request.originPluginId)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "originPluginId cannot use the reserved isolated skill delivery namespace",
    );
  }
  if (request.isolatedSkillDelivery !== true) {
    return null;
  }
  if (request.skillIds === undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "skillIds is required when isolatedSkillDelivery is true",
    );
  }
  return {
    isolatedSkillDelivery: true,
    skillIds: request.skillIds,
    ...(request.hostId !== undefined ? { hostId: request.hostId } : {}),
    ...pickIsolatedContextAllowlist(request),
  };
}

export function persistIsolatedSkillDeliveryPolicy(
  db: DbConnection | DbTransaction,
  args: { threadId: string; policy: PersistedIsolatedSkillDeliveryPolicy | null },
): void {
  if (args.policy === null) {
    return;
  }
  insertThreadPluginMetadata(db, {
    threadId: args.threadId,
    pluginId: ISOLATED_SKILL_DELIVERY_METADATA_PLUGIN_ID,
    metadata: args.policy,
  });
}

export function readIsolatedSkillDeliveryPolicy(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): PersistedIsolatedSkillDeliveryPolicy | null {
  const row = getThreadPluginMetadata(
    deps.db,
    threadId,
    ISOLATED_SKILL_DELIVERY_METADATA_PLUGIN_ID,
  );
  if (row.corrupt) {
    throw new ApiError(
      400,
      "isolated_skill_policy_corrupt",
      "isolated skill delivery metadata is corrupt",
    );
  }
  if (Object.keys(row.metadata).length === 0) {
    return null;
  }
  const parsed = parsePersistedIsolatedSkillDeliveryPolicy(row.metadata);
  if (parsed === null) {
    throw new ApiError(
      400,
      "isolated_skill_policy_corrupt",
      "isolated skill delivery metadata is invalid",
    );
  }
  return parsed;
}

export function resolveForkIsolatedSkillDeliveryPolicy(args: {
  sourcePolicy: PersistedIsolatedSkillDeliveryPolicy | null;
  request: IsolatedSkillDeliveryRequestFields;
}): PersistedIsolatedSkillDeliveryPolicy | null {
  const requested = requestIsolatedSkillDeliveryPolicy(args.request);
  const sourcePolicy = args.sourcePolicy;
  if (sourcePolicy === null) {
    return requested;
  }
  if (requested === null) {
    return sourcePolicy;
  }
  const sameIds =
    requested.skillIds.length === sourcePolicy.skillIds.length &&
    requested.skillIds.every((id, index) => id === sourcePolicy.skillIds[index]);
  const sameAllowlist =
    JSON.stringify(pickIsolatedContextAllowlist(requested)) ===
    JSON.stringify(pickIsolatedContextAllowlist(sourcePolicy));
  if (!sameIds || !sameAllowlist) {
    throw new ApiError(
      400,
      "isolated_skill_policy_immutable",
      "fork cannot change an existing isolated skill delivery policy",
    );
  }
  return sourcePolicy;
}

export const ISOLATED_EMPTY_INSTRUCTIONS_SENTINEL = "isolated";

export function resolveIsolatedDaemonInstructions(args: {
  joinedInstructions: string;
  isolated: boolean;
}): string {
  if (args.isolated && args.joinedInstructions.length === 0) {
    return ISOLATED_EMPTY_INSTRUCTIONS_SENTINEL;
  }
  return args.joinedInstructions;
}

export function opaqueSkillId(identitySeed: string, logicalPath: string): string {
  return `skill_${createHash("sha256")
    .update(`${identitySeed}\0${logicalPath}`)
    .digest("hex")}`;
}

export function catalogEntryOpaqueSkillId(
  entry: ResolvedSkillCatalogEntry,
): string {
  const source = entry.runtimeSource;
  const logicalPath =
    source.kind === "tree"
      ? `${source.name}/${source.entryPath}`
      : `${source.name}/SKILL.md`;
  switch (entry.provenance.kind) {
    case "plugin":
      return opaqueSkillId(
        `bb-plugin:${entry.provenance.pluginId}`,
        logicalPath,
      );
    case "builtin":
      return opaqueSkillId("bb-builtin", logicalPath);
    case "user":
      return opaqueSkillId(
        source.kind === "host-path" ? `host:${source.sourceType}` : "bb-data-dir",
        logicalPath,
      );
    case "project":
      return opaqueSkillId(
        source.kind === "workspace-path"
          ? `bb-project:${source.sourceRootPath}`
          : "bb-project",
        logicalPath,
      );
  }
}

export function injectedSourceDirectory(
  source: HostDaemonInjectedSkillSource,
  resolveTreeHash: (treeHash: string) => string | null,
): string | null {
  if (source.kind === "host-path" || source.kind === "workspace-path") {
    return source.sourceRootPath;
  }
  const treeRoot = resolveTreeHash(source.treeHash);
  if (treeRoot === null) {
    return null;
  }
  const entryDir = dirname(source.entryPath);
  return entryDir === "." || entryDir === ""
    ? treeRoot
    : join(treeRoot, entryDir);
}

export function buildHostIsolatedSkillIndex(args: {
  catalog: readonly ResolvedSkillCatalogEntry[];
  resolveTreeHash: (treeHash: string) => string | null;
}): Map<string, IsolatedSkillRoot> {
  const index = new Map<string, IsolatedSkillRoot>();
  for (const entry of args.catalog) {
    const id = catalogEntryOpaqueSkillId(entry);
    const path = injectedSourceDirectory(
      entry.runtimeSource,
      args.resolveTreeHash,
    );
    if (path === null) {
      continue;
    }
    const existing = index.get(id);
    if (existing !== undefined) {
      throw new ApiError(
        400,
        "isolated_skill_collision",
        `isolatedSkillDelivery catalog collision for ${id}`,
      );
    }
    index.set(id, { id, path, source: entry.runtimeSource });
  }
  return index;
}

export function resolveIsolatedSkillRoots(args: {
  skillIds: readonly string[];
  catalog: readonly ResolvedSkillCatalogEntry[];
  hostId: string;
  policyHostId?: string;
  resolveTreeHash: (treeHash: string) => string | null;
}): IsolatedSkillRoot[] {
  if (args.policyHostId !== undefined && args.policyHostId !== args.hostId) {
    throw new ApiError(
      400,
      "isolated_skill_host_mismatch",
      "isolated skill ids are bound to another host",
    );
  }
  const index = buildHostIsolatedSkillIndex({
    catalog: args.catalog,
    resolveTreeHash: args.resolveTreeHash,
  });
  const resolved: IsolatedSkillRoot[] = [];
  const missing: string[] = [];
  for (const skillId of args.skillIds) {
    const match = index.get(skillId);
    if (match === undefined) {
      missing.push(skillId);
      continue;
    }
    resolved.push(match);
  }
  if (missing.length > 0) {
    throw new ApiError(
      400,
      "isolated_skill_unresolved",
      `isolatedSkillDelivery could not resolve skillIds: ${missing.join(", ")}`,
    );
  }
  return resolved;
}

export function filterInjectedSkillSourcesForIsolation(
  roots: readonly IsolatedSkillRoot[],
): HostDaemonInjectedSkillSource[] {
  return roots.map((root) => root.source);
}

export function isolatedProviderOptionsContext(
  isolation: IsolatedSkillDeliveryContext | null,
): {
  isolatedSkillDelivery?: true;
  skillIds?: readonly string[];
  isolatedSkillRoots?: readonly { id: string; path: string }[];
  allowBridgeToolProxy?: true;
} {
  if (isolation === null) {
    return {};
  }
  return {
    isolatedSkillDelivery: true,
    skillIds: isolation.skillIds,
    isolatedSkillRoots: isolation.isolatedSkillRoots.map((root) => ({
      id: root.id,
      path: root.path,
    })),
    ...(isolation.allowBridgeToolProxy === true
      ? { allowBridgeToolProxy: true }
      : {}),
  };
}

export function mergeIsolatedProviderOptions(
  derived: JsonObject,
  isolation: IsolatedSkillDeliveryContext | null,
): JsonObject {
  if (isolation === null) {
    return { ...derived };
  }
  return {
    ...derived,
    isolatedSkillDelivery: true,
    skillIds: [...isolation.skillIds],
    isolatedSkillRoots: isolation.isolatedSkillRoots.map((root) => ({
      id: root.id,
      path: root.path,
    })),
    ...(isolation.allowBridgeToolProxy === true
      ? { allowBridgeToolProxy: true }
      : {}),
  };
}
