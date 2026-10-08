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
  /**
   * The BB web app. With owner login enforced (`BB_VK_OWNER_AUTH=1`) it is proven by the
   * owner session cookie (`evidence: "owner-session"`); otherwise it is the browser's
   * Origin + Sec-Fetch-Site marks (`evidence: "browser-headers"`), a claim a script on a
   * machine that reaches the hub directly can forge. Check `evidence` for secrets.
   */
  | "owner-ui"
  /**
   * The owner's `bb` CLI, proven by an ed25519 signature of the request with a key
   * paired on the hub (`evidence: "owner-signature"`). Only produced when owner login is
   * enforced; the bare `x-bb-vk-client: cli` header never gives it.
   */
  | "owner-cli"
  /**
   * Owner login is not enforced and the request says it is the `bb` CLI outside an agent
   * session (`x-bb-vk-client: cli`, `evidence: "cli-header"`). Any script can send that:
   * a plugin may allow low-risk calls and must not treat it as the owner for secrets or
   * irreversible actions.
   */
  | "unverified-owner"
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
  | "owner-session"
  | "owner-signature"
  | "none";

export interface ExperimentalVkRpcCaller {
  readonly kind: ExperimentalVkRpcCallerKind;
  /** Set for a verified `agent-thread` (absent when only the CLI said it was in a thread). */
  readonly threadId?: string;
  /** Set for `plugin`. */
  readonly pluginId?: string;
  /**
   * `thread-token`, `plugin-token`, `owner-session` and `owner-signature` are
   * verified by the server. `browser-headers` and `cli-header` are what the client
   * claimed (kind `unverified-owner`): they stop scripts that carry no marks, not a
   * client that forges the headers on purpose.
   */
  readonly evidence: ExperimentalVkRpcCallerEvidence;
}
