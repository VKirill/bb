import {
  VK_REQUIRED_SESSION_POLICY_METADATA_KEY,
  VK_REQUIRED_SESSION_POLICY_PLUGIN_ID,
} from "./vk-session-policy.js";
import { z } from "zod";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Immutable compiled MAIN AgentDefinition payload. Core persists it before
 * the first turn and resumes the same snapshot. `model` and `permissionMode`
 * are omitted so the session user model and required permission ceiling win.
 */
export const VK_COMPILED_MAIN_AGENT_PROVIDER_OPTION = "vkCompiledMainAgent";
export const VK_COMPILED_MAIN_AGENT_METADATA_KEY =
  "experimental_vkCompiledMainAgent";
export const VK_COMPILED_MAIN_AGENT_PLUGIN_ID = "__vk.compiled-main-agent";
export const VK_COMPILED_MAIN_AGENT_PROVIDER_ID = "claude-code";

export const vkCompiledMainAgentSchema = z
  .object({
    id: z.string().min(1).max(80),
    sourceVersion: z.string().min(1).max(80),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().min(1).max(400),
    prompt: z.string().min(1).max(32_000),
    tools: z.array(z.string().min(1)).max(64).optional(),
    disallowedTools: z.array(z.string().min(1)).max(64).optional(),
    skills: z.array(z.string().min(1)).max(64).optional(),
    mcpServers: z.array(z.string().min(1)).max(64).optional(),
  })
  .strict();
export type VkCompiledMainAgent = z.infer<typeof vkCompiledMainAgentSchema>;

export function parseVkCompiledMainAgent(
  value: unknown,
): VkCompiledMainAgent | null {
  if (value === undefined || value === null) return null;
  const parsed = vkCompiledMainAgentSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("vk_compiled_main_agent_incomplete");
  }
  if ("model" in parsed.data || "permissionMode" in parsed.data) {
    throw new Error(
      "vk_compiled_main_agent_must_omit_model_and_permissionMode",
    );
  }
  return parsed.data;
}

export function compiledMainAgentProviderAllowed(providerId: string): boolean {
  return providerId === VK_COMPILED_MAIN_AGENT_PROVIDER_ID;
}

export function mutableMetadataTouchesCompiledAgent(
  metadata: Record<string, unknown>,
  pluginId?: string,
): boolean {
  // Every "__vk." plugin id (snapshots and their required markers) belongs to core.
  if (
    pluginId === VK_COMPILED_MAIN_AGENT_PLUGIN_ID ||
    pluginId === VK_REQUIRED_SESSION_POLICY_PLUGIN_ID ||
    pluginId?.startsWith("__vk.")
  )
    return true;
  if (VK_REQUIRED_SESSION_POLICY_METADATA_KEY in metadata) return true;
  return VK_COMPILED_MAIN_AGENT_METADATA_KEY in metadata;
}

export function readVkCompiledMainAgent(
  providerOptions: unknown,
): VkCompiledMainAgent | null {
  if (
    providerOptions === null ||
    typeof providerOptions !== "object" ||
    Array.isArray(providerOptions)
  ) {
    return null;
  }
  const raw = (providerOptions as Record<string, unknown>)[
    VK_COMPILED_MAIN_AGENT_PROVIDER_OPTION
  ];
  if (raw === undefined) return null;
  return parseVkCompiledMainAgent(raw);
}
