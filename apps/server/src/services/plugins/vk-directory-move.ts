import { z } from "zod";
import type {
  PluginHookInvocation,
  PluginHookProvider,
} from "./plugin-hook-registry.js";

export const VK_DIRECTORY_MOVE_RPC_METHOD = "experimental_vk_directory_move";

const environmentSchema = z.object({
  environmentId: z.string().min(1),
  hostId: z.string().min(1),
  path: z.string().min(1),
});

export const vkDirectoryMoveInputSchema = z.object({
  phase: z.enum(["prepare", "commit", "abort"]),
  operationId: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  source: environmentSchema,
  target: environmentSchema,
});

export const vkDirectoryMoveOutputSchema = z.object({
  ok: z.literal(true),
});

export type VkDirectoryMoveInput = z.infer<typeof vkDirectoryMoveInputSchema>;
export type VkDirectoryMoveOutput = z.infer<typeof vkDirectoryMoveOutputSchema>;

export type VkDirectoryMoveCapability =
  | { kind: "absent" }
  | { kind: "available"; pluginId: string }
  | { kind: "unavailable"; pluginId: string; reason: string };

export function vkDirectoryMoveCapability(
  provider: PluginHookProvider | undefined,
): VkDirectoryMoveCapability {
  const capability = provider?.vkDirectoryMoveCapability?.() ?? {
    kind: "absent" as const,
  };
  return capability.kind === "available" &&
    provider?.invokeVkDirectoryMove === undefined
    ? {
        kind: "unavailable",
        pluginId: capability.pluginId,
        reason: "directory move plugin hook is unavailable",
      }
    : capability;
}

export async function invokeVkDirectoryMove(
  provider: PluginHookProvider | undefined,
  input: VkDirectoryMoveInput,
  signal?: AbortSignal,
): Promise<PluginHookInvocation<VkDirectoryMoveOutput>> {
  const capability = vkDirectoryMoveCapability(provider);
  if (capability.kind === "absent") return { ok: true, value: { ok: true } };
  if (capability.kind === "unavailable") {
    return { ok: false, error: capability.reason };
  }
  if (provider?.invokeVkDirectoryMove === undefined) {
    return { ok: false, error: "directory move plugin hook is unavailable" };
  }
  let outcome: PluginHookInvocation<unknown>;
  try {
    outcome = await provider.invokeVkDirectoryMove(input, signal);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!outcome.ok) return outcome;
  const parsed = vkDirectoryMoveOutputSchema.safeParse(outcome.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: "directory move plugin hook returned an invalid result",
      };
}
