import { z } from "zod";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Launch tuning: a plugin narrows how one agent session is LAUNCHED, which the
 * session policy (`vk-session-policy.ts`, what the session loads) does not
 * reach. It rides in the plugin's own metadata row of the thread, like
 * `experimental_vkQuietChild`:
 *
 *   threads.spawn({ pluginMetadata: { experimental_vkLaunchTuning: { version: 1, acp: { mode: "ask" } } } })
 *
 * Core reads the row at every thread start and turn, and hands the sanitized
 * result to the provider bridge as the `vkLaunchTuning` provider option.
 *
 * - `acp` (bridge `provider-bridge-acp`: Cursor, Devin, Antigravity, ...):
 *   `mode` is applied with the agent's own mode switch right after the
 *   session exists (`session/set_mode`, or `session/set_config_option` for the
 *   agent's `mode` option); `args` are appended to the agent command. There is
 *   no `env` knob: the only restricting variable found (`DEVIN_SANDBOX`) has no
 *   effect under `devin acp` (measured), so nothing would be left to allow.
 * - `claude` (Claude Code): `disallowedTools` is added to the session's
 *   `disallowedTools`; `disableSlashCommands` adds `--disable-slash-commands`
 *   (drops every skill and built-in command, so only for sessions that load none).
 *
 * The layer only NARROWS. ACP `mode` and `args` pass an allow-list that holds
 * the values known to restrict an agent; anything else is dropped. Absent
 * or invalid tuning is a no-op, so a plugin that never sets it is unaffected.
 */
export const VK_LAUNCH_TUNING_VERSION = 1;

/** The plugin metadata key core reads. */
export const VK_LAUNCH_TUNING_METADATA_KEY = "experimental_vkLaunchTuning";

/** The provider option key a bridge reads the sanitized tuning from. */
export const VK_LAUNCH_TUNING_PROVIDER_OPTION = "vkLaunchTuning";

const VK_ACP_ARGS_MAX = 8;
const VK_CLAUDE_TOOLS_MAX = 64;

export const vkAcpLaunchTuningSchema = z
  .object({
    mode: z.string().trim().min(1).max(64).optional(),
    args: z.array(z.string().trim().min(1).max(64)).max(VK_ACP_ARGS_MAX).optional(),
  })
  .strict();
export type VkAcpLaunchTuning = z.infer<typeof vkAcpLaunchTuningSchema>;

export const vkClaudeLaunchTuningSchema = z
  .object({
    disallowedTools: z
      .array(z.string().trim().min(1).max(200))
      .max(VK_CLAUDE_TOOLS_MAX)
      .optional(),
    disableSlashCommands: z.boolean().optional(),
  })
  .strict();
export type VkClaudeLaunchTuning = z.infer<typeof vkClaudeLaunchTuningSchema>;

export const vkLaunchTuningSchema = z
  .object({
    version: z.literal(VK_LAUNCH_TUNING_VERSION),
    acp: vkAcpLaunchTuningSchema.optional(),
    claude: vkClaudeLaunchTuningSchema.optional(),
  })
  .strict();
export type VkLaunchTuning = z.infer<typeof vkLaunchTuningSchema>;

/**
 * ACP modes a plugin may ask for. Every one is the agent's more careful mode
 * (never `agent`, `bypass`, `auto`, `yolo`, `full`): a mode that WIDENS what an
 * agent may do is not launch tuning. Whether a mode really blocks writes is
 * the agent's own business, and it differs per agent (measured by writing a
 * file in each mode, see VK_PATCHES.md): Cursor `ask` and `plan` and Devin
 * `ask` block writes and shell; Antigravity `plan` withholds `run_command`
 * (agent-level, not a sandbox); Devin `plan` does NOT block writes. The caller
 * picks the mode per agent; this list only keeps `agent`/`bypass`/`auto` out.
 */
export const VK_ACP_NARROW_MODES: readonly string[] = [
  "ask",
  "plan",
  "default",
  "accept-edits",
  "read-only",
  "readonly",
];

/**
 * Agent command flags that restrict an agent, each as the exact tokens that
 * must follow one another. `--sandbox`: `agy acp` makes the workspace read-only
 * for its terminal tool (a write outside the workspace still succeeds).
 * `--agent-type review`: `devin acp` starts its review agent, which refused to
 * write in the measured run (its help says "read-only + shell tools").
 */
export const VK_ACP_ARG_RULES: readonly (readonly string[])[] = [
  ["--sandbox"],
  ["--agent-type", "review"],
];

export interface VkAcpLaunch {
  mode?: string;
  args: string[];
  /** What the allow-list refused, for a log line. */
  dropped: string[];
}

/** The part of an ACP tuning that passes the allow-lists. Pure; never throws. */
export function sanitizeVkAcpLaunch(
  acp: VkAcpLaunchTuning | undefined,
): VkAcpLaunch {
  const result: VkAcpLaunch = { args: [], dropped: [] };
  if (!acp) return result;
  if (acp.mode !== undefined) {
    if (VK_ACP_NARROW_MODES.includes(acp.mode)) result.mode = acp.mode;
    else result.dropped.push(`mode ${acp.mode}`);
  }
  const args = acp.args ?? [];
  const taken = new Set<readonly string[]>();
  for (let index = 0; index < args.length; ) {
    const rule = VK_ACP_ARG_RULES.find((candidate) =>
      candidate.every((token, offset) => args[index + offset] === token),
    );
    if (rule) {
      if (!taken.has(rule)) {
        taken.add(rule);
        result.args.push(...rule);
      }
      index += rule.length;
    } else {
      result.dropped.push(`arg ${args[index]}`);
      index += 1;
    }
  }
  return result;
}

/** Parses one plugin metadata value; null when it is not a valid tuning. */
export function parseVkLaunchTuning(value: unknown): VkLaunchTuning | null {
  const parsed = vkLaunchTuningSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reads the tuning out of opaque provider options, or null. Never throws: a bad value is no tuning. */
export function readVkLaunchTuning(
  providerOptions: unknown,
): VkLaunchTuning | null {
  if (
    providerOptions === null ||
    typeof providerOptions !== "object" ||
    Array.isArray(providerOptions)
  ) {
    return null;
  }
  return parseVkLaunchTuning(
    (providerOptions as Record<string, unknown>)[
      VK_LAUNCH_TUNING_PROVIDER_OPTION
    ],
  );
}
