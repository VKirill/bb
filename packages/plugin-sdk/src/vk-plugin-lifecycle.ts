import type { PluginKvStorage } from "./backend-contract.js";
import type { PluginRpcContract } from "./rpc-contract.js";

/** VK extension. Reload and server shutdown never trigger destructive transitions. */
export type ExperimentalVkPluginLifecycleAction =
  | "enable"
  | "disable"
  | "remove";

/** Available to the named experimental_vkLifecycle server export, including while disabled. */
export interface ExperimentalVkPluginLifecycleContext {
  readonly pluginId: string;
  readonly action: ExperimentalVkPluginLifecycleAction;
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
 */
export type ExperimentalVkPluginLifecycleHandler = (
  context: ExperimentalVkPluginLifecycleContext,
) => void | Promise<void>;
