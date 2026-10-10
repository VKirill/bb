import { createHash } from "node:crypto";
import { z } from "zod";
import { createThreadRequestSchema, threadListQuerySchema, threadResponseSchema } from "./threads.js";

export const EXPERIMENTAL_THREAD_SPAWN_CONTRACT_PROTOCOL =
  "bb-experimental-thread-spawn-contract-v1" as const;

export const REQUIRED_THREAD_SPAWN_CREATE_KEYS = [
  "experimental_callerLaunchId",
  "experimental_callerAttemptId",
  "experimental_callerJobId",
  "isolatedSkillDelivery",
  "skillIds",
  "originPluginId",
] as const;

export const experimentalThreadSpawnContractSchema = z
  .object({
    protocol: z.literal(EXPERIMENTAL_THREAD_SPAWN_CONTRACT_PROTOCOL),
    appVersion: z.string().min(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createThreadRequestKeys: z.array(z.string().min(1)),
    threadListQueryKeys: z.array(z.string().min(1)),
    threadResponseKeys: z.array(z.string().min(1)),
    persist: z.object({
      table: z.literal("thread_caller_launches"),
      unique: z.tuple([
        z.literal("origin_plugin_id"),
        z.literal("caller_launch_id"),
      ]),
    }),
    policies: z.object({
      forkDoesNotInheritCallerIdentity: z.literal(true),
      hiddenVisibilitySupported: z.literal(true),
    }),
  })
  .strict();

export type ExperimentalThreadSpawnContract = z.infer<
  typeof experimentalThreadSpawnContractSchema
>;

export function loadedThreadSpawnContractKeys(): {
  createThreadRequestKeys: string[];
  threadListQueryKeys: string[];
  threadResponseKeys: string[];
} {
  return {
    createThreadRequestKeys: Object.keys(createThreadRequestSchema.shape).sort(),
    threadListQueryKeys: Object.keys(threadListQuerySchema.shape).sort(),
    threadResponseKeys: Object.keys(threadResponseSchema.shape).sort(),
  };
}

export function buildExperimentalThreadSpawnContract(
  appVersion: string,
): ExperimentalThreadSpawnContract {
  const keys = loadedThreadSpawnContractKeys();
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        protocol: EXPERIMENTAL_THREAD_SPAWN_CONTRACT_PROTOCOL,
        createThreadRequestKeys: keys.createThreadRequestKeys,
        threadListQueryKeys: keys.threadListQueryKeys,
        threadResponseKeys: keys.threadResponseKeys,
        persist: {
          table: "thread_caller_launches",
          unique: ["origin_plugin_id", "caller_launch_id"],
        },
        policies: {
          forkDoesNotInheritCallerIdentity: true,
          hiddenVisibilitySupported: true,
        },
      }),
    )
    .digest("hex");
  return experimentalThreadSpawnContractSchema.parse({
    protocol: EXPERIMENTAL_THREAD_SPAWN_CONTRACT_PROTOCOL,
    appVersion,
    fingerprint,
    ...keys,
    persist: {
      table: "thread_caller_launches",
      unique: ["origin_plugin_id", "caller_launch_id"],
    },
    policies: {
      forkDoesNotInheritCallerIdentity: true,
      hiddenVisibilitySupported: true,
    },
  });
}
