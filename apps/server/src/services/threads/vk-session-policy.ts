import {
  VK_BRIDGE_MCP_SERVER,
  VK_REQUIRED_PLUGIN_IDS,
  VK_SESSION_POLICY_VERSION,
  vkPolicyAllows,
  type VkPolicyFilter,
  type VkRuntimeSessionPolicy,
  type VkSessionPolicy,
} from "@bb/domain/vk-session-policy";
import type { ResolvedSkillCatalogEntry } from "../skills/injected-skills.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Core's half of a session policy: which BB plugins may contribute, and the
 * runtime half the provider bridge enforces. Built-in contributions (plugin
 * id null) and required plugins always load; a policy narrows plugins, never
 * core itself or what core needs to run threads.
 */
export function vkPluginAllowed(
  policy: VkSessionPolicy | null,
  pluginId: string | null,
): boolean {
  if (policy === null || pluginId === null) return true;
  if (VK_REQUIRED_PLUGIN_IDS.includes(pluginId)) return true;
  return vkPolicyAllows(policy.bbPlugins, pluginId);
}

/** The plugin a contributed env entry came from, or null for host env. */
export function vkEnvPluginId(entry: { source?: unknown }): string | null {
  const source = entry.source;
  if (source !== null && typeof source === "object" && "plugin" in source) {
    const plugin = (source as { plugin: unknown }).plugin;
    return typeof plugin === "string" ? plugin : null;
  }
  return null;
}

export function vkProjectInstructionsAllowed(
  policy: VkSessionPolicy | null,
): boolean {
  return policy?.projectInstructions !== false;
}

export function vkUserInstructionsAllowed(
  policy: VkSessionPolicy | null,
): boolean {
  return policy?.userInstructions !== false;
}

/**
 * The bridge-side policy, or null when nothing is left for a bridge to do.
 * A BB skill is dropped when its plugin is not allowed or its name fails the
 * skills filter; both are resolved here against the catalog, so the bridge
 * gets exact names rather than rules it cannot evaluate.
 */
export function buildVkRuntimeSessionPolicy(
  policy: VkSessionPolicy | null,
  catalog: readonly ResolvedSkillCatalogEntry[],
): VkRuntimeSessionPolicy | null {
  if (policy === null) return null;
  const bbSkillsDenied = [
    ...new Set(
      catalog
        .filter((entry) => {
          const pluginId =
            entry.provenance.kind === "plugin"
              ? entry.provenance.pluginId
              : null;
          return (
            !vkPluginAllowed(policy, pluginId) ||
            !vkPolicyAllows(policy.skills, entry.runtimeSource.name)
          );
        })
        .map((entry) => entry.runtimeSource.name),
    ),
  ].sort();
  const runtime: VkRuntimeSessionPolicy = {
    version: VK_SESSION_POLICY_VERSION,
    ...(bbSkillsDenied.length > 0 ? { bbSkillsDenied } : {}),
    ...(policy.skills ? { skills: policy.skills } : {}),
    ...(policy.mcpServers
      ? { mcpServers: vkKeepBridgeMcp(policy.mcpServers) }
      : {}),
    ...(policy.nativePlugins ? { nativePlugins: policy.nativePlugins } : {}),
    ...(policy.projectInstructions === false
      ? { projectInstructions: false as const }
      : {}),
    ...(policy.claudeAiSync === false ? { claudeAiSync: false as const } : {}),
  };
  return Object.keys(runtime).length > 1 ? runtime : null;
}

/**
 * The MCP filter with bb-bridge kept: an allow list always names it and a
 * deny list never does, so no CLI is told to switch BB's own server off.
 */
function vkKeepBridgeMcp(filter: VkPolicyFilter): VkPolicyFilter {
  const others = filter.names.filter((name) => name !== VK_BRIDGE_MCP_SERVER);
  return {
    mode: filter.mode,
    names: filter.mode === "allow" ? [VK_BRIDGE_MCP_SERVER, ...others] : others,
  };
}
