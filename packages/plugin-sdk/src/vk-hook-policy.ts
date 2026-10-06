import type { ExperimentalVkLifecycleInfo } from "./vk-plugin-lifecycle.js";

/** VK extension. Hooks whose time limit a plugin can raise and whose timeout is made visible. */
export type ExperimentalVkHookName =
  | "messageDispatch"
  | "contributeEnv"
  | "mentionResolve";

/**
 * VK extension: the top-level `vk.hookPolicy` key of a plugin's package.json
 * (beside `bb`, not inside it). Values below 1000 ms are raised to 1000, values
 * above the maximum are lowered to it; invalid entries are ignored with a log line.
 */
export interface ExperimentalVkHookPolicy {
  /** Per-handler decision box of this plugin's `message.dispatch` hook, at most 30000 ms (stock 10000). */
  readonly messageDispatch?: { readonly timeoutMs: number };
  /**
   * Time limit of this plugin's provider env resolver, at most 15000 ms (stock 5000).
   * `required: true`: a timeout or error of the resolver stops the turn from starting.
   */
  readonly contributeEnv?: {
    readonly timeoutMs: number;
    readonly required?: boolean;
  };
  /** Time limit of this plugin's mention `resolve`, at most 30000 ms (stock 10000). */
  readonly mentionResolve?: { readonly timeoutMs: number };
}

/** VK extension: a declared hook did not answer within its time limit. */
export interface ExperimentalVkHookTimeoutEvent {
  readonly hook: ExperimentalVkHookName;
  readonly pluginId: string;
  readonly timeoutMs: number;
  readonly threadId?: string;
  readonly projectId?: string;
  /** True for `contributeEnv` with `required: true`: the turn did not start. */
  readonly required: boolean;
}

/** VK extension: the `bb.vk` namespace. Absent on a core without the VK layer. */
export interface PluginVkApi extends ExperimentalVkLifecycleInfo {
  /**
   * Called when one of this plugin's hooks, for which it declared `vk.hookPolicy`,
   * times out (only timeouts, not other errors). Errors thrown by the callback are
   * swallowed and logged. Feature test: `typeof bb.vk?.experimental_vkOnHookTimeout === "function"`.
   */
  experimental_vkOnHookTimeout(
    callback: (event: ExperimentalVkHookTimeoutEvent) => void | Promise<void>,
  ): { dispose(): void };
}
