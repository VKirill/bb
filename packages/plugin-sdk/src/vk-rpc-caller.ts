/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Who is behind a plugin rpc / CLI call. A plugin opts in with the top-level
 * `vk.rpcCallerPolicy: true` key of its package.json; only then do its rpc
 * handlers (second argument) and its CLI `run(argv, ctx)` receive
 * `experimental_vkCaller`. A plugin without the key sees nothing new.
 *
 * Feature test on an older core: `ctx.experimental_vkCaller === undefined`.
 */
export type ExperimentalVkRpcCallerKind =
  /** The BB web or desktop app (browser fetch metadata; client-asserted). */
  | "owner-ui"
  /** The `bb` CLI outside an agent session (CLI header; client-asserted). */
  | "owner-cli"
  /** A request carrying the per-thread token core puts in the agent's env. */
  | "agent-thread"
  /** Another loaded plugin, verified by the per-load plugin caller token. */
  | "plugin"
  /** No credential and no client marks: curl, python, node fetch, a forged token. */
  | "unknown";

export type ExperimentalVkRpcCallerEvidence =
  | "thread-token"
  | "plugin-token"
  | "browser-headers"
  | "cli-header"
  | "none";

export interface ExperimentalVkRpcCaller {
  readonly kind: ExperimentalVkRpcCallerKind;
  /** Set for a verified `agent-thread` (absent when only the CLI said it was in a thread). */
  readonly threadId?: string;
  /** Set for `plugin`. */
  readonly pluginId?: string;
  /**
   * `thread-token` and `plugin-token` are verified by the server. The others are
   * what the client claimed: they stop curl/python/node scripts that carry no
   * marks, not a client that forges the headers on purpose.
   */
  readonly evidence: ExperimentalVkRpcCallerEvidence;
}
