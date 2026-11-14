import {
  readVkLaunchTuning,
  sanitizeVkAcpLaunch,
  type VkAcpLaunch,
} from "@bb/domain/vk-launch-tuning";
import type { AcpConfigOption } from "./session/session-types.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * The ACP half of launch tuning (`@bb/domain/vk-launch-tuning`): what a plugin
 * asked for when it started the thread, narrowed to the allow-lists. Absent or
 * invalid tuning gives an empty launch, so every call site is a no-op then.
 */
export function vkAcpLaunchFromOptions(
  providerOptions: Record<string, unknown> | undefined,
): VkAcpLaunch {
  const launch = sanitizeVkAcpLaunch(
    readVkLaunchTuning(providerOptions)?.acp,
  );
  if (launch.dropped.length > 0) {
    process.stderr.write(
      `acp bridge: launch tuning dropped what is not on the narrowing allow-list: ${launch.dropped.join(", ")}\n`,
    );
  }
  return launch;
}

interface LaunchModeTarget {
  /** The session's current config options (the agent's own `mode` option, native or legacy `modes`). */
  options(): readonly AcpConfigOption[];
  /** Switches one option the way a user's session-option choice does (`session/set_mode` or `session/set_config_option`). */
  select(optionId: string, value: string): Promise<void>;
  warn(summary: string, details?: string): void;
}

/**
 * Puts the agent into the mode launch tuning asked for. Never throws and never stops the thread: a mode the
 * agent does not offer, or one it refuses, leaves the session as it was and shows a warning in the thread.
 */
export async function vkApplyLaunchMode(
  modeId: string,
  target: LaunchModeTarget,
): Promise<void> {
  const modeOption = () =>
    target
      .options()
      .find((option) => option.category === "mode" && option.type === "select");
  try {
    const option = modeOption();
    if (option === undefined || option.type !== "select") {
      target.warn(
        `Launch tuning asked for mode "${modeId}", but the agent has no mode switch`,
      );
      return;
    }
    if (option.currentValue === modeId) return;
    if (!option.values.some((candidate) => candidate.value === modeId)) {
      target.warn(
        `Launch tuning asked for mode "${modeId}", which the agent does not offer`,
        `Offered: ${option.values.map((candidate) => candidate.value).join(", ")}`,
      );
      return;
    }
    await target.select(option.id, modeId);
    const after = modeOption();
    if (after?.type !== "select" || after.currentValue !== modeId) {
      target.warn(`The agent did not switch to mode "${modeId}"`);
    }
  } catch (error) {
    target.warn(
      `Launch tuning could not set mode "${modeId}"`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
