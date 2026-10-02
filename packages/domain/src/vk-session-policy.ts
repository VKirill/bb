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
  "project-folders",
];

/** BB's own MCP server, which carries BB's and every plugin's tools. */
export const VK_BRIDGE_MCP_SERVER = "bb-bridge";

/** Features this build supports; a plugin feature-tests against these. */
export const VK_EXPERIMENTAL_FEATURES = [
  "session-policy",
  "compiled-main-agent",
] as const;

const VK_POLICY_NAME_MAX = 200;
const VK_POLICY_NAMES_MAX = 500;

const vkPolicyClauseSchema = z
  .object({
    mode: z.enum(["allow", "deny"]),
    names: z
      .array(z.string().trim().min(1).max(VK_POLICY_NAME_MAX))
      .max(VK_POLICY_NAMES_MAX),
  })
  .strict();

export const vkPolicyFilterSchema = vkPolicyClauseSchema
  .extend({
    allOf: z.array(vkPolicyClauseSchema).max(64).optional(),
  })
  .strict();
export type VkPolicyFilter = z.infer<typeof vkPolicyFilterSchema>;

export const vkSessionPolicySchema = z
  .object({
    bbPlugins: vkPolicyFilterSchema.optional(),
    skills: vkPolicyFilterSchema.optional(),
    mcpServers: vkPolicyFilterSchema.optional(),
    nativePlugins: vkPolicyFilterSchema.optional(),
    userInstructions: z.boolean().optional(),
    projectInstructions: z.boolean().optional(),
    claudeAiSync: z.boolean().optional(),
  })
  .strict();
export type VkSessionPolicy = z.infer<typeof vkSessionPolicySchema>;

/**
 * The part of a policy a provider bridge enforces. Core has already applied
 * `bbPlugins` (instructions, agent tools) and `userInstructions`, and turned
 * the BB side of `skills` and `bbPlugins` into `bbSkillsDenied`.
 */
export const vkRuntimeSessionPolicySchema = z
  .object({
    version: z.literal(VK_SESSION_POLICY_VERSION),
    required: z.literal(true).optional(),
    bbSkillsDenied: z
      .array(z.string().trim().min(1).max(VK_POLICY_NAME_MAX))
      .max(VK_POLICY_NAMES_MAX * 4)
      .optional(),
    skills: vkPolicyFilterSchema.optional(),
    mcpServers: vkPolicyFilterSchema.optional(),
    nativePlugins: vkPolicyFilterSchema.optional(),
    projectInstructions: z.literal(false).optional(),
    claudeAiSync: z.literal(false).optional(),
  })
  .strict();
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
  if (filter.allOf?.some((clause) => !vkPolicyAllows(clause, ...names)))
    return false;
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
  const required = "vkRequiredSessionPolicy" in providerOptions;
  if (required && providerOptions.vkRequiredSessionPolicy !== 1)
    throw new Error("vk_required_session_policy_unsupported_version");
  if (raw === undefined || raw === null) {
    if (required) throw new Error("vk_required_session_policy_dropped");
    return null;
  }
  const parsed = vkRuntimeSessionPolicySchema.safeParse(raw);
  if (!parsed.success || (required && parsed.data.required !== true)) {
    if (!required) return null;
    throw new Error("vk_required_session_policy_invalid");
  }
  if (!required && parsed.data.required === true) {
    throw new Error("vk_required_session_policy_marker_dropped");
  }
  return parsed.data;
}

export const VK_REQUIRED_SESSION_POLICY_METADATA_KEY =
  "experimental_vkRequiredSessionPolicy";
export const VK_REQUIRED_SESSION_POLICY_PLUGIN_ID =
  "__vk.required-session-policy";
export const vkRequiredSessionPolicySchema = z
  .object({
    version: z.literal(1),
    policy: vkSessionPolicySchema,
  })
  .strict();
export type VkRequiredSessionPolicy = z.infer<
  typeof vkRequiredSessionPolicySchema
>;

export function intersectVkPolicyFilters(
  filters: readonly (VkPolicyFilter | undefined)[],
): VkPolicyFilter | undefined {
  const clauses = filters.flatMap((filter) =>
    filter
      ? [{ mode: filter.mode, names: filter.names }, ...(filter.allOf ?? [])]
      : [],
  );
  if (clauses.length === 0) return undefined;
  const unique = [
    ...new Map(
      clauses.map((clause) => [JSON.stringify(clause), clause]),
    ).values(),
  ];
  const allow = unique.find((clause) => clause.mode === "allow");
  if (!allow)
    return {
      mode: "deny",
      names: [...new Set(unique.flatMap((clause) => clause.names))].sort(),
    };
  return vkPolicyFilterSchema.parse({
    ...allow,
    allOf: unique.filter((clause) => clause !== allow),
  });
}

export function intersectVkSessionPolicies(
  policies: readonly VkSessionPolicy[],
): VkSessionPolicy {
  const result: VkSessionPolicy = {};
  for (const key of [
    "bbPlugins",
    "skills",
    "mcpServers",
    "nativePlugins",
  ] as const) {
    const filter = intersectVkPolicyFilters(
      policies.map((policy) => policy[key]),
    );
    if (filter) result[key] = filter;
  }
  for (const key of [
    "userInstructions",
    "projectInstructions",
    "claudeAiSync",
  ] as const) {
    if (policies.some((policy) => policy[key] === false)) result[key] = false;
  }
  return vkSessionPolicySchema.parse(result);
}

export function assertVkRequiredPolicyProvider(
  providerId: string,
  policy: VkSessionPolicy,
): void {
  if (
    !["claude-code", "codex", "acp-opencode", "acp-cursor"].includes(providerId)
  ) {
    throw new Error("vk_required_session_policy_unsupported_provider");
  }
  if (providerId !== "claude-code" && policy.claudeAiSync === false) {
    throw new Error("vk_required_session_policy_unsupported_claude_ai_sync");
  }
  if (
    (providerId === "acp-opencode" || providerId === "acp-cursor") &&
    policy.nativePlugins
  ) {
    throw new Error("vk_required_session_policy_unsupported_native_plugins");
  }
  if (
    providerId === "acp-cursor" &&
    (policy.skills || policy.projectInstructions === false)
  ) {
    throw new Error(
      "vk_required_session_policy_unsupported_cursor_instructions_or_skills",
    );
  }
}

export const VK_REQUIRED_SESSION_POLICY_CAPABILITY = {
  version: 1,
  persist: true,
  requiredMarker: true,
  snapshotDigest: true,
  parentCeiling: true,
  bridgeHandshakeVersion: 1,
  // Markers live in reserved thread plugin metadata rows; no table, migration or host-daemon protocol change.
  markerStorage: "thread-plugin-metadata",
  providerGroups: {
    "claude-code": ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    codex: ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
    "acp-opencode": ["bbPlugins", "skills", "mcpServers"],
    "acp-cursor": ["bbPlugins", "mcpServers"],
  },
  instructionSwitches: {
    "claude-code": ["userInstructions", "projectInstructions", "claudeAiSync"],
    codex: ["userInstructions", "projectInstructions"],
    "acp-opencode": ["userInstructions", "projectInstructions"],
    "acp-cursor": ["userInstructions"],
  },
  mandatoryBbPlugins: VK_REQUIRED_PLUGIN_IDS,
  mandatoryMcpServers: [VK_BRIDGE_MCP_SERVER],
} as const;
