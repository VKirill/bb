import type { VkSessionPolicy } from "@bb/domain/vk-session-policy";

/**
 * VK EXPERIMENTAL: args of `threads.experimental_vkInspectRequiredSessionPolicies`.
 * Strict: exactly `threadIds`, 1 to 200 non-empty unique ids; unknown fields reject the whole call.
 */
export interface ExperimentalVkInspectRequiredSessionPoliciesArgs {
  threadIds: string[];
}

/** The stored required-session-policy snapshot of one thread (what `insertVkRequiredSessionPolicy` writes). */
export interface ExperimentalVkRequiredSessionPolicySnapshot {
  version: 1;
  policy: VkSessionPolicy;
  /** Present only on rows written after the ceiling split; absent on legacy rows. */
  ceiling?: VkSessionPolicy;
}

export type ExperimentalVkRequiredSessionPolicyInspection =
  | {
      threadId: string;
      status: "valid";
      snapshot: ExperimentalVkRequiredSessionPolicySnapshot;
    }
  | { threadId: string; status: "absent" }
  | {
      threadId: string;
      status: "invalid";
      reason:
        | "incomplete_snapshot"
        | "malformed_snapshot"
        | "digest_mismatch";
    }
  | { threadId: string; status: "unavailable" };

export interface ExperimentalVkInspectRequiredSessionPoliciesResult {
  version: 1;
  /** One result per requested id, in request order. */
  results: ExperimentalVkRequiredSessionPolicyInspection[];
}

/**
 * The optional method VK builds add to `bb.sdk.threads`. Feature-test it:
 * `typeof bb.sdk.threads.experimental_vkInspectRequiredSessionPolicies === "function"`.
 *
 * Read-only inspection of the stored required-session-policy rows of public threads, instance-wide:
 * any loaded plugin may inspect any public thread; this is not an ownership check and says nothing
 * about effective runtime enforcement. `absent` means no stored requirement was found — never proof
 * of unrestricted behavior. `unavailable` covers a missing, deleted or inaccessible thread without
 * distinguishing which; `invalid` names a corrupt stored snapshot. An operational failure rejects
 * the whole call rather than reporting partial results.
 */
export interface ExperimentalVkRequiredSessionPolicyInspectionMethods {
  experimental_vkInspectRequiredSessionPolicies?(
    args: ExperimentalVkInspectRequiredSessionPoliciesArgs,
  ): Promise<ExperimentalVkInspectRequiredSessionPoliciesResult>;
}
