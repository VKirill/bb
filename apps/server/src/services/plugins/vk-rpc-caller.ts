import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  ExperimentalPluginRpcCaller,
  ExperimentalVkRpcCaller,
} from "@get-bb/plugin-sdk";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Who is behind a plugin rpc / CLI call (`vk.rpcCallerPolicy` in a plugin's
 * package.json). BB's HTTP API has no login: any process that reaches
 * `$BB_SERVER_URL` can post to `/plugins/<id>/rpc/<method>`, so a plugin could not
 * tell the owner's app from an agent running `curl`. This file marks each call:
 *
 * - `agent-thread`: the request carries the per-thread token core puts in the
 *   agent's environment (`BB_VK_THREAD_TOKEN`, sent by the `bb` CLI as a header).
 *   HMAC over the thread id with a key in the data dir; verified by the server.
 *   The token grants nothing: it only lowers the caller's standing.
 * - `plugin`: another plugin, verified by the per-load plugin caller token.
 * - `owner-ui`: a browser request (trusted Origin plus Sec-Fetch-Site same-origin /
 *   same-site). Client-asserted.
 * - `owner-cli`: the `bb` CLI outside an agent session (no BB_THREAD_ID, no token).
 *   Client-asserted. The CLI inside a session without a usable token says
 *   `cli-in-thread` and is marked `agent-thread` without a thread id.
 * - `unknown`: everything else (curl, python, node fetch, a forged token).
 *
 * The two `owner-*` kinds are claims. They stop scripts that carry no marks (the
 * audited bypass); a client that forges the headers on purpose is not stopped.
 * Anything that must resist that needs an owner confirmation outside the call.
 * No schema, no migration, no protocol change: the key is a file in the data dir.
 */

export const VK_THREAD_TOKEN_ENV = "BB_VK_THREAD_TOKEN";
export const VK_THREAD_TOKEN_HEADER = "x-bb-vk-thread-token";
export const VK_CLIENT_HEADER = "x-bb-vk-client";

const KEY_FILE = "vk-rpc-caller.key";
const TOKEN_PREFIX = "vkt1";
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

const keyCache = new Map<string, Buffer>();
let installedDataDir: string | undefined;

/** Wired where the app is assembled: the data dir that holds the signing key. */
export function installVkRpcCaller(deps: { config: { dataDir: string } }): void {
  installedDataDir = deps.config.dataDir;
}

function readOrCreateKey(dataDir: string): Buffer {
  const cached = keyCache.get(dataDir);
  if (cached) return cached;
  const path = join(dataDir, KEY_FILE);
  if (!existsSync(path)) {
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(path, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      // Lost a race with another writer: read what it wrote.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort (non-POSIX file systems).
    }
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  keyCache.set(dataDir, key);
  return key;
}

function sign(dataDir: string, threadId: string): string {
  return createHmac("sha256", readOrCreateKey(dataDir))
    .update(`agent-thread:${threadId}`)
    .digest("base64url");
}

/** The token a thread's shell gets in `BB_VK_THREAD_TOKEN`. */
export function createVkThreadToken(dataDir: string, threadId: string): string {
  return `${TOKEN_PREFIX}.${threadId}.${sign(dataDir, threadId)}`;
}

/** The thread id a token was minted for, or null when it is malformed or forged. */
export function verifyVkThreadToken(
  dataDir: string,
  token: string | undefined,
): string | null {
  if (token === undefined) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, threadId, signature] = parts as [string, string, string];
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  const expected = Buffer.from(sign(dataDir, threadId));
  const presented = Buffer.from(signature);
  return expected.length === presented.length &&
    timingSafeEqual(expected, presented)
    ? threadId
    : null;
}

/** Env entry for a thread's shell, in the shape core already uses for contributed env. */
export function vkThreadTokenEnvEntry(
  dataDir: string,
  threadId: string,
): {
  name: string;
  value: string;
  source: { core: "machine-environment" };
  reason: string;
} {
  return {
    name: VK_THREAD_TOKEN_ENV,
    value: createVkThreadToken(dataDir, threadId),
    source: { core: "machine-environment" },
    reason:
      "VK EXPERIMENTAL: marks this session's API calls as an agent thread's",
  };
}

export const VK_UNKNOWN_CALLER: ExperimentalVkRpcCaller = {
  kind: "unknown",
  evidence: "none",
};

export interface ClassifyVkRpcCallerArgs {
  header(name: string): string | undefined;
  /** Existing resolution of the plugin caller token (`client` when none). */
  pluginCaller: ExperimentalPluginRpcCaller;
  /** The browser guard accepted the request (a missing Origin also passes it). */
  browserGuardPassed: boolean;
  /** Overrides the installed data dir (tests). */
  dataDir?: string;
}

export function classifyVkRpcCaller(
  args: ClassifyVkRpcCallerArgs,
): ExperimentalVkRpcCaller {
  if (args.pluginCaller.kind === "plugin") {
    return {
      kind: "plugin",
      pluginId: args.pluginCaller.pluginId,
      evidence: "plugin-token",
    };
  }
  const dataDir = args.dataDir ?? installedDataDir;
  const tokenHeader = args.header(VK_THREAD_TOKEN_HEADER);
  if (tokenHeader !== undefined) {
    const threadId =
      dataDir === undefined ? null : verifyVkThreadToken(dataDir, tokenHeader);
    // A token that does not verify is a forgery, not an anonymous call.
    return threadId === null
      ? VK_UNKNOWN_CALLER
      : { kind: "agent-thread", threadId, evidence: "thread-token" };
  }
  const origin = args.header("origin");
  const fetchSite = args.header("sec-fetch-site");
  if (
    origin !== undefined &&
    args.browserGuardPassed &&
    (fetchSite === "same-origin" || fetchSite === "same-site")
  ) {
    return { kind: "owner-ui", evidence: "browser-headers" };
  }
  if (origin === undefined) {
    const client = args.header(VK_CLIENT_HEADER);
    if (client === "cli") return { kind: "owner-cli", evidence: "cli-header" };
    // The CLI saw BB_THREAD_ID but no usable token (a session that started before
    // the token existed): still an agent's call, just not verified.
    if (client === "cli-in-thread") {
      return { kind: "agent-thread", evidence: "cli-header" };
    }
  }
  return VK_UNKNOWN_CALLER;
}

/** Opt-in key of the plugin's package.json: top-level `vk.rpcCallerPolicy: true`. */
export function readVkRpcCallerManifest(vk: unknown): {
  vkRpcCallerPolicy?: true;
} {
  return typeof vk === "object" &&
    vk !== null &&
    (vk as { rpcCallerPolicy?: unknown }).rpcCallerPolicy === true
    ? { vkRpcCallerPolicy: true }
    : {};
}
