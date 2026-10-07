import type { PluginKvStorage } from "./backend-contract.js";
import type { PluginRpcContract } from "./rpc-contract.js";

/**
 * VK extension. `enable`, `disable` and `remove` are the managed transitions. `reload` and `shutdown` are
 * never destructive and run only for a plugin that declares `vk.lifecycle.drain` in its package.json: the
 * handler of the instance being replaced (or stopped) gets the chance to quiesce before it is disposed.
 */
export type ExperimentalVkPluginLifecycleAction =
  | "enable"
  | "disable"
  | "remove"
  | "reload"
  | "shutdown";

/**
 * Package.json manifest field (a top-level `vk` key beside `bb`) that opts a plugin into drain on reload and
 * shutdown. `timeoutMs` is the deadline for the handler and the longest time new work waits for the new
 * instance; 1000 to 600000, default 30000.
 */
export interface ExperimentalVkLifecycleDrainManifest {
  lifecycle?: { drain?: { timeoutMs?: number } };
}

/** Why this plugin instance was started. `boot`: server start or first load; `enable`: switched on; `reload`: replaced a running instance. */
export type ExperimentalVkLifecycleStartReason = "boot" | "enable" | "reload";

/**
 * `bb.vk` on a VK build (undefined on stock BB; feature-test `bb.vk?.startReason`). Read `afterDrain` from a
 * background service or handler, not from the factory: the factory of a reloaded plugin runs before the
 * previous instance has drained, so inside the factory `afterDrain` is still false.
 */
export interface ExperimentalVkLifecycleInfo {
  readonly startReason: ExperimentalVkLifecycleStartReason;
  /** True when this instance replaced one whose `reload` drain handler finished before its deadline. */
  readonly afterDrain: boolean;
  /**
   * Unique per plugin instance. The `reload` and `shutdown` drain handler receives the id of the instance it
   * drains as `context.instanceId`; key per-instance state by it, because a reload with the same build runs the
   * new factory (same module) before the old instance drains.
   */
  readonly instanceId: string;
}

/** Available to the named experimental_vkLifecycle server export, including while disabled. */
export interface ExperimentalVkPluginLifecycleContext {
  readonly pluginId: string;
  readonly action: ExperimentalVkPluginLifecycleAction;
  /** Epoch ms after which a `reload` or `shutdown` drain is aborted (`signal`). Absent for the other actions. */
  readonly deadline?: number;
  /** For `reload` and `shutdown`: `bb.vk.instanceId` of the instance being drained. */
  readonly instanceId?: string;
  readonly signal: AbortSignal;
  readonly kv: PluginKvStorage;
  /** Uses the existing authenticated host RPC transport and contract validation. */
  callHost(args: {
    contract: PluginRpcContract;
    method: string;
    input: unknown;
    hostId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/**
 * Export as experimental_vkLifecycle alongside the default server factory.
 * Must be idempotent. Throw to prevent disable/removal; retain progress in kv
 * for retry. The ordinary factory is not run to remove a disabled plugin.
 * On `reload` and `shutdown` it runs in the module instance being replaced; a throw or the deadline is logged
 * and the reload or shutdown goes on. While it runs, new message.dispatch, contributeEnv, mention, tool-call
 * and schedule work for this plugin waits for the new instance.
 */
export type ExperimentalVkPluginLifecycleHandler = (
  context: ExperimentalVkPluginLifecycleContext,
) => void | Promise<void>;
