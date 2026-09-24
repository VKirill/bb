import { z } from "zod";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * A session policy narrows what one agent session loads: BB plugins (their
 * instructions, agent tools and skills), skills by name, provider-native MCP
 * servers and provider-native CLI plugins. A plugin supplies it per thread
 * through `bb.agents.experimental_vkSessionPolicy`; core applies the BB side
 * itself and hands the provider side to the provider bridge as the
 * `vkSessionPolicy` provider option.
 *
 * Every field is optional. An absent field means "load what bb loads today",
 * so an empty policy is a no-op. `allow` keeps only the listed names, `deny`
 * drops the listed names. Names are matched exactly; a trailing `*` matches a
 * prefix (`lane-stack:*`).
 */
export const VK_SESSION_POLICY_VERSION = 1;

/** The provider option key a bridge reads the runtime policy from. */
export const VK_SESSION_POLICY_PROVIDER_OPTION = "vkSessionPolicy";

/**
 * BB plugins no session policy may leave out: BB cannot start or show
 * threads without them, so when one is installed it is always in the session
 * and never excluded from a place. `environment-project-checkout` provisions
 * the environments threads run in.
 */
export const VK_REQUIRED_PLUGIN_IDS: readonly string[] = [
  "environment-project-checkout",
];

/** BB's own MCP server, which carries BB's and every plugin's tools. */
export const VK_BRIDGE_MCP_SERVER = "bb-bridge";

/** Features this build supports; a plugin feature-tests against these. */
export const VK_EXPERIMENTAL_FEATURES = ["session-policy"] as const;

const VK_POLICY_NAME_MAX = 200;
const VK_POLICY_NAMES_MAX = 500;

export const vkPolicyFilterSchema = z.object({
  mode: z.enum(["allow", "deny"]),
  names: z
    .array(z.string().trim().min(1).max(VK_POLICY_NAME_MAX))
    .max(VK_POLICY_NAMES_MAX),
});
export type VkPolicyFilter = z.infer<typeof vkPolicyFilterSchema>;

export const vkSessionPolicySchema = z.object({
  /** BB plugin ids: their instructions, agent tools and skills. */
  bbPlugins: vkPolicyFilterSchema.optional(),
  /** Skill names as the agent invokes them (`ru-text`, `lane-stack:ru-text`). */
  skills: vkPolicyFilterSchema.optional(),
  /** Provider-native MCP server names (`~/.claude.json`, codex config.toml, …). */
  mcpServers: vkPolicyFilterSchema.optional(),
  /** Provider-native CLI plugins (Claude `name@marketplace`, codex plugin ids). */
  nativePlugins: vkPolicyFilterSchema.optional(),
  /** Whether `<dataDir>/AGENTS.md` user instructions load. Default true. */
  userInstructions: z.boolean().optional(),
  /**
   * Whether project instructions load: the workspace `.bb/AGENTS.md` BB adds,
   * and the `CLAUDE.md` / `AGENTS.md` files the CLI finds in the folder and
   * its parents. Default true.
   */
  projectInstructions: z.boolean().optional(),
  /** Whether Claude Code syncs skills and plugins from claude.ai. Default true. */
  claudeAiSync: z.boolean().optional(),
});
export type VkSessionPolicy = z.infer<typeof vkSessionPolicySchema>;

/**
 * The part of a policy a provider bridge enforces. Core has already applied
 * `bbPlugins` (instructions, agent tools) and `userInstructions`, and turned
 * the BB side of `skills` and `bbPlugins` into `bbSkillsDenied`.
 */
export const vkRuntimeSessionPolicySchema = z.object({
  version: z.literal(VK_SESSION_POLICY_VERSION),
  /**
   * BB-delivered skills (plugin, `<dataDir>/skills`, project `.bb/skills`)
   * the bridge must drop. Core computes the exact names from its catalog, so
   * this is always a deny list.
   */
  bbSkillsDenied: z
    .array(z.string().trim().min(1).max(VK_POLICY_NAME_MAX))
    .max(VK_POLICY_NAMES_MAX * 4)
    .optional(),
  /** Provider-native skills (the CLI's own skill directories and plugins). */
  skills: vkPolicyFilterSchema.optional(),
  mcpServers: vkPolicyFilterSchema.optional(),
  nativePlugins: vkPolicyFilterSchema.optional(),
  /** Set to false when the CLI must skip project instruction files. */
  projectInstructions: z.literal(false).optional(),
  /** Set to false when Claude Code must not sync from claude.ai. */
  claudeAiSync: z.literal(false).optional(),
});
export type VkRuntimeSessionPolicy = z.infer<
  typeof vkRuntimeSessionPolicySchema
>;

/**
 * What one BB plugin puts into agent sessions, so a policy editor can tell
 * plugins that shape the context from plugins that only add UI.
 * `configure` means the plugin selects its tools and skills (and may add
 * instructions) per thread, so what reaches a given session can be less.
 */
export interface VkContextContribution {
  pluginId: string;
  /** No policy can leave this plugin out (see `VK_REQUIRED_PLUGIN_IDS`). */
  required: boolean;
  instructions: boolean;
  configure: boolean;
  tools: string[];
  skills: string[];
}

/** Whether `name` matches one entry: exact, or a `prefix*` wildcard. */
export function vkPolicyNameMatches(pattern: string, name: string): boolean {
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/**
 * Whether `filter` lets `name` through. Several candidate spellings of one
 * item (a bare skill name and its `plugin:skill` form) may be passed: an
 * allow list admits the item when any spelling is listed, a deny list drops
 * it when any spelling is listed.
 */
export function vkPolicyAllows(
  filter: VkPolicyFilter | undefined,
  ...names: readonly string[]
): boolean {
  if (!filter) return true;
  const listed = names.some((name) =>
    filter.names.some((pattern) => vkPolicyNameMatches(pattern, name)),
  );
  return filter.mode === "allow" ? listed : !listed;
}

/** Reads the runtime policy out of opaque provider options, or null. */
export function readVkRuntimeSessionPolicy(
  providerOptions: unknown,
): VkRuntimeSessionPolicy | null {
  if (
    providerOptions === null ||
    typeof providerOptions !== "object" ||
    Array.isArray(providerOptions)
  ) {
    return null;
  }
  const raw = (providerOptions as Record<string, unknown>)[
    VK_SESSION_POLICY_PROVIDER_OPTION
  ];
  if (raw === undefined || raw === null) return null;
  const parsed = vkRuntimeSessionPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
