import { z } from "zod";
import { vkSwitchKeys, type VkSwitchKey } from "./vk-features.js";

export const experimentKeys = [
  "agentCpuPriority",
  "compactExpiredCache",
  "keyedPluginCss",
  "serverMove",
  "performanceDiagnostics",
  "pluginUpdates",
  "resumeDaemonSessions",
  "skipFocusedThreadNotifications",
  "threadContextCard",
  "walCheckpointWorker",
  // VK EXPERIMENTAL: on/off switches of our VK functions (see vk-features.ts).
  ...vkSwitchKeys,
] as const;
export const experimentKeySchema = z.enum(experimentKeys);
export type ExperimentKey = z.infer<typeof experimentKeySchema>;
// VK EXPERIMENTAL: the upstream Experiments list leaves VK switches to «Функции VK».
export type UpstreamExperimentKey = Exclude<ExperimentKey, VkSwitchKey>;
export function isUpstreamExperimentKey(
  key: ExperimentKey,
): key is UpstreamExperimentKey {
  return !(vkSwitchKeys as readonly string[]).includes(key);
}

export const experimentsSchema = z.record(experimentKeySchema, z.boolean());
export type Experiments = z.infer<typeof experimentsSchema>;

export const experimentUpdatesSchema = z.partialRecord(
  experimentKeySchema,
  z.boolean(),
);
export type ExperimentUpdates = z.infer<typeof experimentUpdatesSchema>;

// VK EXPERIMENTAL: every VK switch is on by default and for early adopters.
export const vkExperimentsOn = Object.fromEntries(
  vkSwitchKeys.map((key) => [key, true]),
) as Record<VkSwitchKey, true>;

export const defaultExperiments: Experiments = {
  agentCpuPriority: false,
  compactExpiredCache: false,
  keyedPluginCss: false,
  serverMove: false,
  performanceDiagnostics: false,
  pluginUpdates: false,
  resumeDaemonSessions: false,
  skipFocusedThreadNotifications: false,
  threadContextCard: false,
  walCheckpointWorker: false,
  ...vkExperimentsOn,
};

export const earlyAdopterExperiments: Experiments = {
  agentCpuPriority: true,
  compactExpiredCache: true,
  keyedPluginCss: true,
  serverMove: false,
  performanceDiagnostics: false,
  pluginUpdates: true,
  resumeDaemonSessions: true,
  skipFocusedThreadNotifications: true,
  threadContextCard: true,
  walCheckpointWorker: true,
  ...vkExperimentsOn,
};
