import { z } from "zod";

export const isolatedSkillRootSchema = z.object({
  id: z.string().trim().min(1).max(180),
  path: z.string().min(1),
});

export const isolatedSkillDeliveryProviderOptionsSchema = z.object({
  isolatedSkillDelivery: z.boolean().optional(),
  skillIds: z.array(z.string().trim().min(1).max(180)).max(32).optional(),
  isolatedSkillRoots: z.array(isolatedSkillRootSchema).max(32).optional(),
});

export type IsolatedSkillRoot = z.infer<typeof isolatedSkillRootSchema>;

export function isIsolatedSkillDelivery(
  providerOptions: { isolatedSkillDelivery?: boolean } | undefined,
): boolean {
  return providerOptions?.isolatedSkillDelivery === true;
}
