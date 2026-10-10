import { createHash } from "node:crypto";
import {
  getThread,
  getThreadCallerLaunchByKey,
  getThreadPluginMetadata,
  type DbConnection,
} from "@bb/db";
import { jsonValueSchema, type Thread } from "@bb/domain";
import {
  CALLER_LAUNCH_METADATA_PLUGIN_ID,
  canonicalJson,
  isReservedCallerLaunchPluginId,
  isReservedIsolatedSkillDeliveryPluginId,
  parsePersistedCallerLaunchIdentity,
  serializeCallerLaunchBinding,
  type CallerLaunchRequestFields,
  type PersistedCallerLaunchIdentity,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

export interface CallerLaunchReservation {
  identity: PersistedCallerLaunchIdentity;
  originPluginId: string;
  callerLaunchId: string;
  bindingJson: string;
}

export function assertWritablePluginMetadataNamespace(pluginId: string): void {
  if (
    isReservedIsolatedSkillDeliveryPluginId(pluginId) ||
    isReservedCallerLaunchPluginId(pluginId)
  ) {
    throw new ApiError(
      403,
      "forbidden",
      "Reserved plugin metadata cannot be written by clients",
    );
  }
}

export function requestCallerLaunchIdentity(
  request: CallerLaunchRequestFields & {
    origin?: string | null;
    originPluginId?: string;
  },
): PersistedCallerLaunchIdentity | null {
  const hasAny =
    request.experimental_callerLaunchId !== undefined ||
    request.experimental_callerAttemptId !== undefined ||
    request.experimental_callerJobId !== undefined;
  if (!hasAny) {
    return null;
  }
  if (request.origin !== "plugin" || request.originPluginId === undefined) {
    throw new ApiError(
      400,
      "invalid_request",
      "caller identity requires origin \"plugin\" and originPluginId",
    );
  }
  if (
    isReservedCallerLaunchPluginId(request.originPluginId) ||
    isReservedIsolatedSkillDeliveryPluginId(request.originPluginId)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "originPluginId cannot use a reserved metadata namespace",
    );
  }
  if (
    request.experimental_callerLaunchId === undefined ||
    request.experimental_callerAttemptId === undefined
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "experimental_callerLaunchId and experimental_callerAttemptId are required together",
    );
  }
  return {
    callerLaunchId: request.experimental_callerLaunchId,
    callerAttemptId: request.experimental_callerAttemptId,
    originPluginId: request.originPluginId,
    ...(request.experimental_callerJobId === undefined
      ? {}
      : { callerJobId: request.experimental_callerJobId }),
  };
}

export function callerLaunchPromptDigest(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function buildCallerLaunchReservation(args: {
  identity: PersistedCallerLaunchIdentity | null;
  projectId: string;
  providerId: string;
  model: string | null;
  environment: unknown;
  environmentId: string | null;
  isolatedSkillDelivery: boolean;
  skillIds: readonly string[] | undefined;
  input: unknown;
}): CallerLaunchReservation | null {
  if (args.identity === null) {
    return null;
  }
  const skillIds = [...new Set(args.skillIds ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  return {
    identity: args.identity,
    originPluginId: args.identity.originPluginId,
    callerLaunchId: args.identity.callerLaunchId,
    bindingJson: serializeCallerLaunchBinding({
      callerAttemptId: args.identity.callerAttemptId,
      callerJobId: args.identity.callerJobId ?? null,
      projectId: args.projectId,
      providerId: args.providerId,
      model: args.model,
      environment: jsonValueSchema.parse(
        JSON.parse(canonicalJson(args.environment)),
      ),
      environmentId: args.environmentId,
      isolatedSkillDelivery: args.isolatedSkillDelivery,
      skillIds,
      promptDigest: callerLaunchPromptDigest(args.input),
    }),
  };
}

function boundThreadOrConflict(
  db: DbConnection,
  reservation: CallerLaunchReservation,
  existing: { threadId: string; bindingJson: string },
): Thread {
  if (existing.bindingJson !== reservation.bindingJson) {
    throw new ApiError(
      409,
      "caller_launch_conflict",
      "callerLaunchId is already bound for this originPluginId",
    );
  }
  const thread = getThread(db, existing.threadId);
  if (thread === null || thread.deletedAt !== null) {
    throw new ApiError(
      409,
      "caller_launch_conflict",
      "callerLaunchId is already bound for this originPluginId",
    );
  }
  return thread;
}

export function findCallerLaunchThreadId(
  db: DbConnection,
  args: { originPluginId: string; callerLaunchId: string },
): { threadId: string; identity: PersistedCallerLaunchIdentity } | null {
  const row = getThreadCallerLaunchByKey(db, args);
  if (row === null) {
    return null;
  }
  const metadata = getThreadPluginMetadata(
    db,
    row.threadId,
    CALLER_LAUNCH_METADATA_PLUGIN_ID,
  );
  const identity = parsePersistedCallerLaunchIdentity(metadata.metadata);
  if (identity === null) {
    return { threadId: row.threadId, identity: {
      originPluginId: row.originPluginId,
      callerLaunchId: row.callerLaunchId,
      callerAttemptId: "unknown",
    } };
  }
  return { threadId: row.threadId, identity };
}

export function resolveCallerLaunchCreate(
  db: DbConnection,
  reservation: CallerLaunchReservation | null,
): { replayThread: Thread } | { persist: CallerLaunchReservation } | {
  persist: null;
} {
  if (reservation === null) {
    return { persist: null };
  }
  const existing = getThreadCallerLaunchByKey(db, {
    originPluginId: reservation.originPluginId,
    callerLaunchId: reservation.callerLaunchId,
  });
  if (existing === null) {
    return { persist: reservation };
  }
  return {
    replayThread: boundThreadOrConflict(db, reservation, existing),
  };
}

export function resolveCallerLaunchUniqueConflict(
  db: DbConnection,
  reservation: CallerLaunchReservation,
): Thread {
  const existing = getThreadCallerLaunchByKey(db, {
    originPluginId: reservation.originPluginId,
    callerLaunchId: reservation.callerLaunchId,
  });
  if (existing === null) {
    throw new ApiError(
      409,
      "caller_launch_conflict",
      "callerLaunchId is already bound for this originPluginId",
    );
  }
  return boundThreadOrConflict(db, reservation, existing);
}

export function readCallerLaunchIdentity(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): PersistedCallerLaunchIdentity | null {
  const row = getThreadPluginMetadata(
    deps.db,
    threadId,
    CALLER_LAUNCH_METADATA_PLUGIN_ID,
  );
  if (row.corrupt || Object.keys(row.metadata).length === 0) {
    return null;
  }
  return parsePersistedCallerLaunchIdentity(row.metadata);
}

export function callerLaunchResponseFields(
  identity: PersistedCallerLaunchIdentity | null,
): {
  experimental_callerLaunchId?: string;
  experimental_callerAttemptId?: string;
  experimental_callerJobId?: string;
} {
  if (identity === null) {
    return {};
  }
  return {
    experimental_callerLaunchId: identity.callerLaunchId,
    experimental_callerAttemptId: identity.callerAttemptId,
    ...(identity.callerJobId === undefined
      ? {}
      : { experimental_callerJobId: identity.callerJobId }),
  };
}
