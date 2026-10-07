import { threadScope } from "@bb/domain";
import type {
  ExperimentalVkHookName,
  ExperimentalVkHookPolicy,
  ExperimentalVkHookTimeoutEvent,
  PluginVkApi,
} from "@get-bb/plugin-sdk";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { appendSystemErrorEvent } from "../threads/thread-events.js";
import { vkDrainNotReadyMessage } from "./vk-plugin-drain.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Per-plugin hook time limits (`vk.hookPolicy` in package.json) and visible
 * hook timeouts. A plugin that declares nothing gets BB's stock limits and the
 * stock silent behaviour; every function here is a no-op for it.
 */

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS: Record<ExperimentalVkHookName, number> = {
  messageDispatch: 30_000,
  contributeEnv: 15_000,
  mentionResolve: 30_000,
};

type VkHookPolicyLogger = Pick<AppDeps["logger"], "warn">;
let logger: VkHookPolicyLogger | undefined;
let appendRow: ((threadId: string, message: string) => void) | undefined;

/** Wired where the app is assembled: the thread timeline and the logger. */
export function installVkHookPolicy(
  deps: Pick<AppDeps, "db" | "hub" | "logger">,
): void {
  logger = deps.logger;
  appendRow = (threadId, message) =>
    appendSystemErrorEvent(deps, {
      threadId,
      code: "vk_hook_timeout",
      message,
      scope: threadScope(),
    });
}

function warn(message: string, fields: Record<string, unknown> = {}): void {
  if (logger) logger.warn(fields, message);
  else console.warn(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTimeoutMs(
  hook: ExperimentalVkHookName,
  raw: unknown,
): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warn(`vk.hookPolicy.${hook}.timeoutMs must be a number; entry ignored`);
    return undefined;
  }
  const clamped = Math.min(
    MAX_TIMEOUT_MS[hook],
    Math.max(MIN_TIMEOUT_MS, Math.round(raw)),
  );
  if (clamped !== raw) {
    warn(
      `vk.hookPolicy.${hook}.timeoutMs ${raw} is out of range; using ${clamped}`,
    );
  }
  return clamped;
}

/** Lenient: invalid or out-of-range values are clamped or ignored with a warning, never thrown. */
export function parseVkHookPolicy(
  raw: unknown,
): ExperimentalVkHookPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warn("vk.hookPolicy must be an object; ignored");
    return undefined;
  }
  const policy: {
    messageDispatch?: { timeoutMs: number };
    contributeEnv?: { timeoutMs: number; required?: boolean };
    mentionResolve?: { timeoutMs: number };
  } = {};
  for (const hook of Object.keys(MAX_TIMEOUT_MS) as ExperimentalVkHookName[]) {
    const entry = raw[hook];
    if (entry === undefined) continue;
    if (!isRecord(entry)) {
      warn(`vk.hookPolicy.${hook} must be an object; entry ignored`);
      continue;
    }
    const timeoutMs = parseTimeoutMs(hook, entry.timeoutMs);
    if (timeoutMs === undefined) continue;
    if (hook === "contributeEnv") {
      if (entry.required !== undefined && typeof entry.required !== "boolean") {
        warn("vk.hookPolicy.contributeEnv.required must be a boolean; ignored");
      }
      policy.contributeEnv = {
        timeoutMs,
        ...(entry.required === true ? { required: true } : {}),
      };
    } else {
      policy[hook] = { timeoutMs };
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(key in MAX_TIMEOUT_MS))
      warn(`vk.hookPolicy.${key} is unknown; ignored`);
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

/** The `vk` part of a plugin manifest, from the package.json `vk` key (only `hookPolicy` is read here). */
export function readVkHookPolicyManifest(vk: unknown): {
  vk?: { hookPolicy?: ExperimentalVkHookPolicy };
} {
  const hookPolicy = parseVkHookPolicy(
    isRecord(vk) ? vk.hookPolicy : undefined,
  );
  return hookPolicy === undefined ? {} : { vk: { hookPolicy } };
}

/** The plugin's own limit for a hook, or the stock one when it declared none. */
export function vkHookTimeoutMs(
  policy: ExperimentalVkHookPolicy | undefined,
  hook: ExperimentalVkHookName,
  stockMs: number,
): number {
  return policy?.[hook]?.timeoutMs ?? stockMs;
}

/** True when `error` is the stock time-box message of that hook, not another failure. */
export function vkIsHookTimeout(
  hook: ExperimentalVkHookName,
  error: string,
  timeoutMs: number,
): boolean {
  return hook === "messageDispatch"
    ? error === `did not decide within ${timeoutMs}ms`
    : error === `timed out after ${timeoutMs}ms`;
}

type TimeoutCallback = {
  run: (event: ExperimentalVkHookTimeoutEvent) => void | Promise<void>;
};
const timeoutCallbacks = new Map<string, Set<TimeoutCallback>>();

/** `bb.vk` members for one plugin; spread into the plugin's `vk` namespace. */
export function createVkHookPolicyApi(args: {
  pluginId: string;
  assertLive(): void;
  onDispose(hook: () => void): void;
}): Pick<PluginVkApi, "experimental_vkOnHookTimeout"> {
  return {
    experimental_vkOnHookTimeout(callback) {
      args.assertLive();
      if (typeof callback !== "function") {
        throw new Error("experimental_vkOnHookTimeout expects a function");
      }
      const entry: TimeoutCallback = { run: callback };
      let set = timeoutCallbacks.get(args.pluginId);
      if (set === undefined) {
        set = new Set();
        timeoutCallbacks.set(args.pluginId, set);
      }
      set.add(entry);
      const dispose = () => {
        const current = timeoutCallbacks.get(args.pluginId);
        current?.delete(entry);
        if (current?.size === 0) timeoutCallbacks.delete(args.pluginId);
      };
      args.onDispose(dispose);
      return { dispose };
    },
  };
}

function timeoutText(event: ExperimentalVkHookTimeoutEvent): string {
  const outcome =
    event.hook === "messageDispatch"
      ? "dispatch hook not applied"
      : event.hook === "mentionResolve"
        ? "mention not resolved"
        : event.required
          ? "env required, turn not started"
          : "env not applied";
  return `plugin ${event.pluginId} did not answer in ${event.timeoutMs} ms: ${outcome}`;
}

/**
 * A declared hook timed out: one service row on the thread timeline (when the
 * thread is known) and every callback the plugin registered. Neither can fail
 * the caller. The returned promise settles once the callbacks have; callers
 * need not await it.
 */
export function reportVkHookTimeout(
  event: ExperimentalVkHookTimeoutEvent,
): Promise<void> {
  if (event.threadId !== undefined && appendRow !== undefined) {
    try {
      appendRow(event.threadId, timeoutText(event));
    } catch (error) {
      warn("vk hook timeout row could not be appended", {
        err: error,
        pluginId: event.pluginId,
        threadId: event.threadId,
      });
    }
  }
  return Promise.all(
    [...(timeoutCallbacks.get(event.pluginId) ?? [])].map(async (entry) => {
      try {
        await entry.run(event);
      } catch (error) {
        warn("vk hook timeout callback threw", {
          err: error,
          pluginId: event.pluginId,
        });
      }
    }),
  ).then(() => undefined);
}

/**
 * Provider env resolver of a plugin failed. A timeout of a plugin that declared
 * `contributeEnv` is reported; with `required: true` any failure (timeout or
 * error) throws a retryable 503 so the turn does not start without the env.
 * No-op for a plugin without a `contributeEnv` policy.
 */
export function handleVkEnvFailure(args: {
  pluginId: string;
  policy: ExperimentalVkHookPolicy | undefined;
  timeoutMs: number;
  error: string;
  threadId: string;
  projectId: string;
}): void {
  const declared = args.policy?.contributeEnv;
  if (declared === undefined) return;
  const required = declared.required === true;
  const timedOut = vkIsHookTimeout("contributeEnv", args.error, args.timeoutMs);
  if (timedOut) {
    void reportVkHookTimeout({
      hook: "contributeEnv",
      pluginId: args.pluginId,
      timeoutMs: args.timeoutMs,
      threadId: args.threadId,
      projectId: args.projectId,
      required,
    });
  }
  if (required) {
    throw new ApiError(
      503,
      "vk_required_env_unavailable",
      `Plugin "${args.pluginId}" must provide the environment for this turn but ${
        timedOut
          ? `did not answer in ${args.timeoutMs} ms`
          : `failed: ${args.error}`
      }. The turn was not started; retry.`,
      { details: { pluginId: args.pluginId }, retryable: true },
    );
  }
}

/** A `messageDispatch` or `mentionResolve` hook failed: report it when it was a timeout of a declared policy. */
export function noteVkHookFailure(args: {
  hook: "messageDispatch" | "mentionResolve";
  pluginId: string;
  policy: ExperimentalVkHookPolicy | undefined;
  timeoutMs: number;
  error: string;
  threadId?: string;
  projectId?: string;
  /** The drain hold ran out (the plugin was still draining): its declared drain timeout, in ms. */
  drainHoldMs?: number | undefined;
}): void {
  if (args.policy?.[args.hook] === undefined) return;
  const drainHoldExpired =
    args.drainHoldMs !== undefined &&
    args.error === vkDrainNotReadyMessage(args.pluginId);
  if (
    !drainHoldExpired &&
    !vkIsHookTimeout(args.hook, args.error, args.timeoutMs)
  )
    return;
  void reportVkHookTimeout({
    hook: args.hook,
    pluginId: args.pluginId,
    timeoutMs: drainHoldExpired
      ? (args.drainHoldMs ?? args.timeoutMs)
      : args.timeoutMs,
    ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
    ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    required: false,
  });
}
