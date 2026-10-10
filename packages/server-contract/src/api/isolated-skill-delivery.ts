import { z } from "zod";

export const ISOLATED_SKILL_DELIVERY_METADATA_PLUGIN_ID =
  "bb-isolated-skill-delivery";

export const opaqueSkillIdSchema = z
  .string()
  .regex(
    /^skill_[a-f0-9]{64}$/u,
    "skillIds must be opaque host catalog ids (skill_<sha256>)",
  );

export const isolatedSkillIdsSchema = z
  .array(opaqueSkillIdSchema)
  .min(1)
  .max(32)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "skillIds must be unique",
  });

export const isolatedSkillRootSchema = z.object({
  id: opaqueSkillIdSchema,
  path: z.string().min(1),
});

export const isolatedContextAllowlistSchema = z.object({
  dynamicToolNames: z
    .array(z.string().trim().min(1).max(80))
    .max(32)
    .optional(),
  instructionPluginIds: z
    .array(z.string().trim().min(1).max(80))
    .max(32)
    .optional(),
  includeDataDirInstructions: z.boolean().optional(),
  includeWorkspaceInstructions: z.boolean().optional(),
  allowBridgeToolProxy: z.boolean().optional(),
});

export type IsolatedContextAllowlist = z.infer<
  typeof isolatedContextAllowlistSchema
>;

export const isolatedSkillDeliveryRequestFieldsSchema =
  isolatedContextAllowlistSchema.extend({
    isolatedSkillDelivery: z.boolean().optional(),
    skillIds: isolatedSkillIdsSchema.optional(),
  });

export type IsolatedSkillDeliveryRequestFields = z.infer<
  typeof isolatedSkillDeliveryRequestFieldsSchema
>;

export const persistedIsolatedSkillDeliveryPolicySchema =
  isolatedContextAllowlistSchema.extend({
    isolatedSkillDelivery: z.literal(true),
    skillIds: isolatedSkillIdsSchema,
    hostId: z.string().min(1).optional(),
  });

export type PersistedIsolatedSkillDeliveryPolicy = z.infer<
  typeof persistedIsolatedSkillDeliveryPolicySchema
>;

export function refineIsolatedSkillDeliveryRequest(
  value: IsolatedSkillDeliveryRequestFields,
  addIssue: (message: string, path: Array<string | number>) => void,
): void {
  if (value.isolatedSkillDelivery === true && value.skillIds === undefined) {
    addIssue(
      "skillIds is required when isolatedSkillDelivery is true",
      ["skillIds"],
    );
  }
}

export function parsePersistedIsolatedSkillDeliveryPolicy(
  metadata: unknown,
): PersistedIsolatedSkillDeliveryPolicy | null {
  const parsed = persistedIsolatedSkillDeliveryPolicySchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

export function isReservedIsolatedSkillDeliveryPluginId(
  pluginId: string,
): boolean {
  return pluginId === ISOLATED_SKILL_DELIVERY_METADATA_PLUGIN_ID;
}

export function isolatedAllowsDynamicTool(
  policy: PersistedIsolatedSkillDeliveryPolicy,
  toolName: string,
): boolean {
  return policy.dynamicToolNames?.includes(toolName) === true;
}

export function isolatedAllowsInstructionPlugin(
  policy: PersistedIsolatedSkillDeliveryPolicy,
  pluginId: string,
): boolean {
  return policy.instructionPluginIds?.includes(pluginId) === true;
}

export function isolatedAllowsDataDirInstructions(
  policy: PersistedIsolatedSkillDeliveryPolicy,
): boolean {
  return policy.includeDataDirInstructions === true;
}

export function isolatedAllowsWorkspaceInstructions(
  policy: PersistedIsolatedSkillDeliveryPolicy,
): boolean {
  return policy.includeWorkspaceInstructions === true;
}

export function isolatedAllowsBridgeToolProxy(
  policy: PersistedIsolatedSkillDeliveryPolicy,
): boolean {
  return policy.allowBridgeToolProxy === true;
}

export function pickIsolatedContextAllowlist(
  value: IsolatedContextAllowlist,
): IsolatedContextAllowlist {
  return {
    ...(value.dynamicToolNames !== undefined
      ? { dynamicToolNames: value.dynamicToolNames }
      : {}),
    ...(value.instructionPluginIds !== undefined
      ? { instructionPluginIds: value.instructionPluginIds }
      : {}),
    ...(value.includeDataDirInstructions !== undefined
      ? { includeDataDirInstructions: value.includeDataDirInstructions }
      : {}),
    ...(value.includeWorkspaceInstructions !== undefined
      ? { includeWorkspaceInstructions: value.includeWorkspaceInstructions }
      : {}),
    ...(value.allowBridgeToolProxy !== undefined
      ? { allowBridgeToolProxy: value.allowBridgeToolProxy }
      : {}),
  };
}
