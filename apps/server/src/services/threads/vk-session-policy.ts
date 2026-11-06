import {
  VK_BRIDGE_MCP_SERVER,
  VK_REQUIRED_PLUGIN_IDS,
  VK_SESSION_POLICY_VERSION,
  vkPolicyAllows,
  vkProviderEnforcesPolicyInCore,
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

/**
 * Env is the one exception: the plugin that started the thread wrote its
 * policy, so its own env (lane markers, guard PATH) still reaches the thread
 * while the policy keeps that plugin's skills, tools and instructions out.
 */
export function vkEnvPluginAllowed(
  policy: VkSessionPolicy | null,
  pluginId: string | null,
  originPluginId: string | null | undefined,
): boolean {
  if (pluginId !== null && pluginId === originPluginId) return true;
  return vkPluginAllowed(policy, pluginId);
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

/**
 * VK EXPERIMENTAL: providers whose CLI reads <workspace>/AGENTS.md from the
 * cwd itself, so the server's copy arrives twice. Evidence (2026-11-06,
 * thr_exknr6pddz ctx-audit): codex — every rollout carries a separate
 * "# AGENTS.md instructions for <cwd>" user message on top of the inlined
 * developer message (~/.codex/sessions, argon-report §1.3); claude-code —
 * the native block lists the project's CLAUDE.md/AGENTS.md chain
 * (~/.claude/projects/*.jsonl); acp-opencode and opencode2 — OpenCode loads
 * project AGENTS.md/CLAUDE.md itself (OPENCODE_DISABLE_PROJECT_CONFIG is the
 * switch the bridge uses to stop it); acp-cursor — cursor-agent reads
 * AGENTS.md from the workspace (a policy cannot disable project
 * instructions for ACP providers precisely because the CLI loads them);
 * devin — "Devin CLI reads this file automatically" per its rules docs, and
 * a Lane Pilot writer's first message carried the file twice
 * (~/.local/share/devin/cli/sessions.db). zcode and acp-antigravity have no
 * verified native read, so they keep the inlined copy.
 */
const VK_PROVIDERS_READING_WORKSPACE_INSTRUCTIONS: readonly string[] = [
  "acp-cursor",
  "acp-opencode",
  "claude-code",
  "codex",
  "devin",
  "opencode2",
];

export function vkProjectInstructionsAllowed(
  policy: VkSessionPolicy | null,
  providerId?: string,
): boolean {
  if (
    providerId !== undefined &&
    VK_PROVIDERS_READING_WORKSPACE_INSTRUCTIONS.includes(providerId)
  )
    return false;
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
 * VK EXPERIMENTAL: a provider whose bridge cannot filter (OpenCode v2) gets
 * the BB skill list already narrowed; the bridges of the other providers
 * filter by `bbSkillsDenied` themselves.
 */
export function vkFilterCoreEnforcedSkillSources<
  Source extends { name: string },
>(
  providerId: string,
  sources: readonly Source[],
  runtime: VkRuntimeSessionPolicy | null,
): Source[] {
  const denied = new Set(runtime?.bbSkillsDenied ?? []);
  if (!vkProviderEnforcesPolicyInCore(providerId) || denied.size === 0)
    return [...sources];
  return sources.filter((source) => !denied.has(source.name));
}

/**
 * The MCP filter with bb-bridge kept: an allow list always names it and a
 * deny list never does, so no CLI is told to switch BB's own server off.
 */
function vkKeepBridgeMcp(filter: VkPolicyFilter): VkPolicyFilter {
  const others = filter.names.filter((name) => name !== VK_BRIDGE_MCP_SERVER);
  const allOf = filter.allOf?.map(vkKeepBridgeMcp);
  return {
    mode: filter.mode,
    ...(allOf ? { allOf } : {}),
    names: filter.mode === "allow" ? [VK_BRIDGE_MCP_SERVER, ...others] : others,
  };
}
