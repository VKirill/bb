import {
  VK_SESSION_POLICY_VERSION,
  vkPolicyAllows,
  type VkRuntimeSessionPolicy,
  type VkSessionPolicy,
} from "@bb/domain/vk-session-policy";
import type { ResolvedSkillCatalogEntry } from "../skills/injected-skills.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Core's half of a session policy: which BB plugins may contribute, and the
 * runtime half the provider bridge enforces. Built-in contributions (plugin
 * id null) always load; a policy narrows plugins, never core itself.
 */
export function vkPluginAllowed(
  policy: VkSessionPolicy | null,
  pluginId: string | null,
): boolean {
  if (policy === null || pluginId === null) return true;
  return vkPolicyAllows(policy.bbPlugins, pluginId);
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
    ...(policy.mcpServers ? { mcpServers: policy.mcpServers } : {}),
    ...(policy.nativePlugins ? { nativePlugins: policy.nativePlugins } : {}),
  };
  return Object.keys(runtime).length > 1 ? runtime : null;
}
