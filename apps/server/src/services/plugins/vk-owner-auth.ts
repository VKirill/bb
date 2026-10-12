import { timingSafeEqual } from "node:crypto";
import {
  consumeVkOwnerPairingCode,
  isVkOwnerAuthEnabled,
  isVkOwnerEnforced,
  isVkOwnerPublicKey,
  addVkOwnerKey,
  parseVkOwnerSignature,
  parseVkOwnerTicket,
  readVkOwnerState,
  VK_OWNER_COOKIE,
  VK_OWNER_SESSION_MS,
  VK_OWNER_SIG_HEADER,
  verifyVkOwnerRequestSignature,
  verifyVkOwnerTicketSignature,
  type ParsedVkOwnerSignature,
} from "@bb/config/vk-owner-auth";
import { getThread, type DbConnection } from "@bb/db";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { ApiError } from "../../errors.js";
import type { ServerLogger } from "../../types.js";
import {
  VK_CLIENT_HEADER,
  VK_THREAD_TOKEN_HEADER,
  verifyVkThreadToken,
  vkInstalledDataDir,
  vkSignLabel,
  type VkOwnerProofKind,
} from "./vk-rpc-caller.js";
import type { PluginRpcCallerResolution } from "./plugin-rpc-caller.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Owner login for the hub (opt-in: `BB_VK_OWNER_AUTH=1`, default off).
 *
 * Trust root: an ed25519 public key paired on the hub (`<dataDir>/vk-owner.json`).
 * The private key stays on the owner's machine (macOS Keychain, or a 0600 file
 * outside work folders; never an env var) and is used by the `bb` CLI to
 *   1. sign every owner-relevant request (`x-bb-vk-owner-sig`), and
 *   2. sign a one-minute login ticket that a browser trades for a session cookie
 *      (`vk_owner`, HttpOnly, SameSite=Strict, 90 days).
 * Agent thread tokens never carry owner rights: a request that carries one is
 * never an owner. Without the flag nothing here is consulted for identity; the
 * gate below only refuses agent-marked callers that answer the owner's form.
 * Installing plugins and writing files on a host stay open to agents (a PM ships
 * its own plugin, guards are installed with `bb file write`; owner, 2026-10-12).
 */

const SESSION_PREFIX = "vko1";
const NONCE_TTL_MS = 5 * 60_000;
const seenNonces = new Map<string, number>();

function claimNonce(keyId: string, nonce: string, now: number): boolean {
  for (const [key, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(key);
  }
  const key = `${keyId}:${nonce}`;
  if (seenNonces.has(key)) return false;
  seenNonces.set(key, now + NONCE_TTL_MS);
  return true;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// session cookie

export function mintVkOwnerSessionCookie(
  dataDir: string,
  keyId: string,
  now = Date.now(),
): { value: string; maxAgeSeconds: number } {
  const epoch = readVkOwnerState(dataDir).epoch;
  const expiresAt = now + VK_OWNER_SESSION_MS;
  const body = `${keyId}.${epoch}.${expiresAt}`;
  return {
    value: `${SESSION_PREFIX}.${body}.${vkSignLabel(dataDir, `owner-session:${body}`)}`,
    maxAgeSeconds: Math.floor(VK_OWNER_SESSION_MS / 1000),
  };
}

/** The key id a cookie was minted for, or null when forged, expired, revoked or its key is gone. */
export function verifyVkOwnerSessionCookie(
  dataDir: string,
  value: string | undefined,
  now = Date.now(),
): string | null {
  if (value === undefined) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== SESSION_PREFIX) return null;
  const [, keyId, epochText, expiresText, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    !safeEqual(
      signature,
      vkSignLabel(dataDir, `owner-session:${keyId}.${epochText}.${expiresText}`),
    )
  ) {
    return null;
  }
  if (Number(expiresText) <= now) return null;
  const state = readVkOwnerState(dataDir);
  if (Number(epochText) !== state.epoch) return null;
  return state.keys.some((key) => key.id === keyId) ? keyId : null;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// proof of the owner for one request

export interface VkOwnerProofInput {
  dataDir: string;
  method: string;
  /** Path plus query, as received. */
  target: string;
  header(name: string): string | undefined;
  readBody(): Promise<Uint8Array>;
  now?: number;
  /** The cookie needs an Origin (state-changing calls); a read-only status check relaxes it. */
  requireOrigin?: boolean;
}

/** A signature or session cookie the hub accepts, else null. Agent tokens never qualify. */
export async function verifyVkOwnerProof(
  input: VkOwnerProofInput,
): Promise<VkOwnerProofKind | null> {
  const now = input.now ?? Date.now();
  // An agent's token rules out the owner whatever else is attached.
  if (input.header(VK_THREAD_TOKEN_HEADER) !== undefined) return null;
  const signatureHeader = input.header(VK_OWNER_SIG_HEADER);
  if (signatureHeader !== undefined) {
    const parsed = parseVkOwnerSignature(signatureHeader);
    if (parsed === null) return null;
    const key = readVkOwnerState(input.dataDir).keys.find(
      (candidate) => candidate.id === parsed.keyId,
    );
    if (key === undefined) return null;
    const ok = verifyVkOwnerRequestSignature({
      publicKey: key.publicKey,
      parsed,
      method: input.method,
      target: input.target,
      body: await input.readBody(),
      now,
    });
    if (!ok || !claimNonce(parsed.keyId, parsed.nonce, now)) return null;
    return { kind: "owner-cli", evidence: "owner-signature" };
  }
  const cookie = verifyVkOwnerSessionCookie(
    input.dataDir,
    readCookie(input.header("cookie"), VK_OWNER_COOKIE),
    now,
  );
  if (cookie === null) return null;
  // The cookie is for the browser app: Origin (already checked by the browser
  // guard) and fetch metadata must say so, on top of SameSite=Strict.
  const fetchSite = input.header("sec-fetch-site");
  if (
    ((input.requireOrigin ?? true) && input.header("origin") === undefined) ||
    (fetchSite !== "same-origin" && fetchSite !== "same-site")
  ) {
    return null;
  }
  return { kind: "owner-ui", evidence: "owner-session" };
}

const proofCache = new WeakMap<Request, Promise<VkOwnerProofKind | null>>();

/** Verified once per request: a signature nonce can be claimed only once. */
export function vkOwnerProofFor(
  context: Context,
  dataDir: string,
  options: { requireOrigin?: boolean } = {},
): Promise<VkOwnerProofKind | null> {
  const raw = context.req.raw;
  const cached = proofCache.get(raw);
  if (cached !== undefined) return cached;
  const url = new URL(context.req.url);
  const pending = verifyVkOwnerProof({
    dataDir,
    method: context.req.method,
    target: `${url.pathname}${url.search}`,
    header: (name) => context.req.header(name),
    readBody: async () => new Uint8Array(await context.req.arrayBuffer()),
    ...(options.requireOrigin === undefined
      ? {}
      : { requireOrigin: options.requireOrigin }),
  }).catch(() => null);
  proofCache.set(raw, pending);
  return pending;
}

/** What `classifyVkRpcCaller` needs to tell the owner from a script (call before reading the body). */
export async function vkOwnerAuthFor(
  context: Context,
): Promise<{ enforced: boolean; proof: VkOwnerProofKind | null }> {
  const dataDir = vkInstalledDataDir();
  if (!isVkOwnerAuthEnabled() || dataDir === undefined) {
    return { enforced: false, proof: null };
  }
  return {
    enforced: isVkOwnerEnforced(dataDir),
    proof: await vkOwnerProofFor(context, dataDir),
  };
}

// ---------------------------------------------------------------------------
// routes core leaves open to any caller

const API_PREFIX = "/api/v1";

type GatedGroup = "plugins" | "interactions" | "files";

/** Routes through which an agent could escalate; matched on the path below `/api/v1`. */
const OWNER_GATED_ROUTES: ReadonlyArray<
  readonly [string, RegExp, GatedGroup]
> = [
  // install / configure plugins
  ["POST", /^\/plugins\/install$/u, "plugins"],
  ["POST", /^\/plugin-catalog\/install$/u, "plugins"],
  ["POST", /^\/marketplaces$/u, "plugins"],
  ["DELETE", /^\/marketplaces\/[^/]+$/u, "plugins"],
  ["POST", /^\/plugins\/[^/]+\/update$/u, "plugins"],
  ["PUT", /^\/plugins\/[^/]+\/settings$/u, "plugins"],
  ["POST", /^\/plugins\/[^/]+\/token$/u, "plugins"],
  ["DELETE", /^\/plugins\/[^/]+$/u, "plugins"],
  // the owner's forms: an agent must not answer them itself
  ["POST", /^\/threads\/[^/]+\/interactions\/[^/]+\/(?:respond|resolve|cancel)$/u, "interactions"],
  // writing files on a machine (bb file write --host)
  ["POST", /^\/files\/(?:write|mkdir|move|remove)$/u, "files"],
];

function gatedGroup(method: string, path: string): GatedGroup | null {
  const below = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path;
  const upper = method.toUpperCase();
  return (
    OWNER_GATED_ROUTES.find(
      ([routeMethod, pattern]) => routeMethod === upper && pattern.test(below),
    )?.[2] ?? null
  );
}

export function isVkOwnerGatedRoute(method: string, path: string): boolean {
  return gatedGroup(method, path) !== null;
}

const AGENT_REFUSAL =
  "An agent session cannot answer this form or approval request: only the owner can (the pending card in the BB app, or `bb thread interactions ...` in his terminal), or a parent thread for the sub-agents it started. Ask the owner to answer it.";

const OWNER_REFUSAL =
  "This action needs the owner. In the BB app, sign in once with `bb owner login` (the link opens the app signed in); in a terminal use the `bb` CLI on a machine paired with `bb owner pair`. From an agent session ask the owner. `bb owner status` shows what the hub sees.";

const INTERACTION_PATH =
  /^\/threads\/([^/]+)\/interactions\//u;
const MAX_ANCESTOR_DEPTH = 12;

/** True when `threadId` was started (directly or through helpers) by `ancestorId`. */
export function isVkThreadDescendant(
  db: DbConnection,
  threadId: string,
  ancestorId: string,
): boolean {
  let current: string | null = threadId;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && current !== null; depth++) {
    const row = getThread(db, current);
    if (row === undefined || row === null) return false;
    const next: string | null =
      row.parentThreadId ?? row.sourceThreadId ?? row.lifecycleOwnerThreadId;
    if (next === ancestorId) return true;
    current = next;
  }
  return false;
}

export interface VkOwnerGateDeps {
  config: { dataDir: string };
  db: DbConnection;
  logger: ServerLogger;
  plugins: {
    resolveRpcCaller(token: string | undefined): PluginRpcCallerResolution;
  };
}

/**
 * Login enforced (flag on, a key paired, grace over): only a verified owner (session
 * or signature) may use the gated routes. Flag off, or on but nothing paired yet /
 * still in the grace: callers marked as an agent (thread token, even a forged one, or the CLI
 * saying it runs inside a session) are refused and logged on the owner's forms only; plugin
 * and file routes and everyone else pass as before. That is a speed bump against an agent that does not hide, not a boundary:
 * a script that omits the marks still passes. Only enforced login is a boundary.
 */
export function createVkOwnerGate(deps: VkOwnerGateDeps): MiddlewareHandler {
  return async (context, next) => {
    const group = gatedGroup(context.req.method, context.req.path);
    if (group === null) return next();
    const plugin = deps.plugins.resolveRpcCaller(
      context.req.header("x-bb-plugin-caller"),
    );
    // A loaded plugin (docs, monaco-editor, secrets, tasks...) acts through its own tools.
    if (plugin.ok && plugin.caller.kind === "plugin") return next();
    const meta = {
      method: context.req.method,
      path: context.req.path,
    };
    if (isVkOwnerAuthEnabled()) {
      const proof = await vkOwnerProofFor(context, deps.config.dataDir);
      if (proof !== null) return next();
    }
    const token = context.req.header(VK_THREAD_TOKEN_HEADER);
    const threadId =
      token === undefined
        ? null
        : verifyVkThreadToken(deps.config.dataDir, token);
    // A verified parent thread may answer the interactions of the sub-agents it started
    // (`bb thread interactions ...`); never its own or anyone else's.
    if (group === "interactions" && threadId !== null) {
      const target = INTERACTION_PATH.exec(
        context.req.path.slice(API_PREFIX.length),
      )?.[1];
      if (target !== undefined && isVkThreadDescendant(deps.db, target, threadId)) {
        return next();
      }
    }
    if (isVkOwnerEnforced(deps.config.dataDir)) {
      deps.logger.warn(
        { ...meta, threadId, hadSignature: context.req.header(VK_OWNER_SIG_HEADER) !== undefined },
        "VK owner login: refused a call without a valid owner session or signature",
      );
      throw new ApiError(403, "vk_owner_required", OWNER_REFUSAL);
    }
    const inSession =
      token !== undefined ||
      context.req.header(VK_CLIENT_HEADER) === "cli-in-thread";
    if (inSession && group === "interactions") {
      deps.logger.warn(
        { ...meta, threadId, forgedToken: token !== undefined && threadId === null },
        "VK owner gate: refused an agent-marked call to an owner-only core route",
      );
      throw new ApiError(403, "vk_agent_caller_refused", AGENT_REFUSAL);
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// pairing, login ticket, status

function secureRequest(context: Context): boolean {
  const forwarded = context.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  return (forwarded ?? new URL(context.req.url).protocol.replace(/:$/u, "")) === "https";
}

function setSessionCookie(
  context: Context,
  cookie: { value: string; maxAgeSeconds: number } | null,
): void {
  const attributes = [
    `${VK_OWNER_COOKIE}=${cookie?.value ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${cookie?.maxAgeSeconds ?? 0}`,
  ];
  if (secureRequest(context)) attributes.push("Secure");
  context.header("Set-Cookie", attributes.join("; "), { append: true });
}

export function registerVkOwnerRoutes(
  app: Hono,
  deps: { config: { dataDir: string }; logger: ServerLogger },
): void {
  const { dataDir } = deps.config;

  // The CLI trades the one-time code (minted on the hub with `bb owner pairing-code`)
  // plus its new public key for a registered owner key. Inert without a pending code.
  app.post("/vk/owner/pair", async (context) => {
    context.header("Cache-Control", "no-store");
    const body = (await context.req.json().catch(() => null)) as {
      code?: unknown;
      publicKey?: unknown;
      label?: unknown;
    } | null;
    if (
      typeof body?.code !== "string" ||
      typeof body.publicKey !== "string" ||
      !isVkOwnerPublicKey(body.publicKey)
    ) {
      throw new ApiError(400, "invalid_request", "expected { code, publicKey, label? }");
    }
    const result = consumeVkOwnerPairingCode(dataDir, body.code);
    if (result !== "ok") {
      deps.logger.warn({ result }, "VK owner pairing refused");
      throw new ApiError(
        403,
        "vk_pairing_refused",
        result === "none"
          ? "No pairing code is pending. Run `bb owner pairing-code` on the hub."
          : `Pairing code ${result}. Run \`bb owner pairing-code\` on the hub for a new one.`,
      );
    }
    const record = addVkOwnerKey(dataDir, {
      publicKey: body.publicKey,
      label: typeof body.label === "string" && body.label.length > 0 ? body.label : "owner",
    });
    deps.logger.warn({ keyId: record.id, label: record.label }, "VK owner key paired");
    return context.json({
      ok: true,
      keyId: record.id,
      enforceFrom: readVkOwnerState(dataDir).enforceFrom,
    });
  });

  // One-time trade of a signed ticket for the session cookie, then on to the app.
  app.get("/vk/owner/session", (context) => {
    context.header("Cache-Control", "no-store");
    const parsed: ParsedVkOwnerSignature | null = parseVkOwnerTicket(
      context.req.query("ticket"),
    );
    const key =
      parsed === null
        ? undefined
        : readVkOwnerState(dataDir).keys.find((candidate) => candidate.id === parsed.keyId);
    const now = Date.now();
    if (
      parsed === null ||
      key === undefined ||
      !verifyVkOwnerTicketSignature({ publicKey: key.publicKey, parsed, now }) ||
      !claimNonce(`ticket:${parsed.keyId}`, parsed.nonce, now)
    ) {
      throw new ApiError(403, "vk_ticket_refused", "The login ticket is invalid, expired or already used.");
    }
    setSessionCookie(context, mintVkOwnerSessionCookie(dataDir, key.id, now));
    return context.redirect("/", 302);
  });

  app.post("/vk/owner/logout", (context) => {
    setSessionCookie(context, null);
    return context.json({ ok: true });
  });

  app.get("/vk/owner/status", async (context) => {
    context.header("Cache-Control", "no-store");
    const enabled = isVkOwnerAuthEnabled();
    const proof = enabled
      ? await vkOwnerProofFor(context, dataDir, { requireOrigin: false })
      : null;
    const state = readVkOwnerState(dataDir);
    return context.json({
      enabled,
      enforced: isVkOwnerEnforced(dataDir),
      enforceFrom: state.enforceFrom,
      paired: state.keys.length > 0,
      owner: proof !== null,
    });
  });
}
