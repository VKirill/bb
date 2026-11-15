// VK EXPERIMENTAL: `threads.experimental_vkInspectRequiredSessionPolicies` — read-only inspection of the stored
// required-session-policy rows (packages/db/src/data/thread-required-session-policy.ts) for a bounded batch of
// public threads. Instance-wide by design: any loaded plugin may inspect any public thread; this is not an
// ownership check and says nothing about effective runtime enforcement. See
// packages/plugin-sdk/src/vk-required-session-policy-inspection.ts for the contract.
import { z } from "zod";
import { readVkRequiredSessionPolicy } from "@bb/db";
import type { DbConnection, DbTransaction } from "@bb/db";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../lib/entity-lookup.js";
import type {
  ExperimentalVkInspectRequiredSessionPoliciesArgs,
  ExperimentalVkInspectRequiredSessionPoliciesResult,
  ExperimentalVkRequiredSessionPolicyInspection,
} from "@get-bb/plugin-sdk";

const inspectArgsSchema = z
  .object({
    threadIds: z.array(z.string().min(1)).min(1).max(200),
  })
  .strict()
  .refine(
    (args) => new Set(args.threadIds).size === args.threadIds.length,
    { message: "threadIds must not contain duplicates" },
  );

function isThreadNotFound(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.body.code === "thread_not_found"
  );
}

function inspectOne(
  db: DbConnection,
  tx: DbTransaction,
  threadId: string,
): ExperimentalVkRequiredSessionPolicyInspection {
  try {
    requirePublicThread(db, threadId);
  } catch (error) {
    if (isThreadNotFound(error)) return { threadId, status: "unavailable" };
    throw error;
  }
  try {
    const snapshot = readVkRequiredSessionPolicy(tx, threadId);
    if (snapshot === null) return { threadId, status: "absent" };
    return {
      threadId,
      status: "valid",
      snapshot: {
        version: 1,
        policy: snapshot.policy,
        ...(snapshot.ceiling === undefined ? {} : { ceiling: snapshot.ceiling }),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "vk_required_session_policy_dropped") {
      return { threadId, status: "invalid", reason: "incomplete_snapshot" };
    }
    if (message === "vk_required_session_policy_digest_mismatch") {
      return { threadId, status: "invalid", reason: "digest_mismatch" };
    }
    // JSON.parse failures surface as SyntaxError; schema validation as ZodError. Both mean the stored
    // snapshot is corrupt — reported as malformed, never as absent and never with its raw payload.
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return { threadId, status: "invalid", reason: "malformed_snapshot" };
    }
    throw error;
  }
}

export function createVkRequiredSessionPolicyInspectionMethods(input: {
  db: DbConnection;
  /** The loaded plugin's liveness gate: a retained SDK reference rejects after the plugin is disposed. */
  assertLive: () => void;
}) {
  const { db, assertLive } = input;
  return {
    async experimental_vkInspectRequiredSessionPolicies(
      args: ExperimentalVkInspectRequiredSessionPoliciesArgs,
    ): Promise<ExperimentalVkInspectRequiredSessionPoliciesResult> {
      assertLive();
      const parsed = inspectArgsSchema.parse(args);
      // One synchronous read transaction over the bounded batch: visibility through the captured connection,
      // the policy reader through the transaction, no writes and no await inside.
      const results = db.transaction((tx) =>
        parsed.threadIds.map((threadId) => inspectOne(db, tx, threadId)),
      );
      return { version: 1, results };
    },
  };
}
