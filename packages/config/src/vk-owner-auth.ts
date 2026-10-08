import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Owner login primitives shared by the server (verifies) and the `bb` CLI (signs).
 * BB's HTTP API has no login. With the opt-in flag `BB_VK_OWNER_AUTH=1` the server
 * trusts "this is the owner" only for
 *   - a request signed (ed25519) by an owner key that was paired on the hub, or
 *   - a browser session cookie the hub minted for a signed login ticket.
 * The private key lives only on the owner's machines (macOS Keychain, or a 0600
 * file outside work folders) and never in an environment variable. The hub keeps
 * public keys only, in `<dataDir>/vk-owner.json`. No schema, no migration, no
 * host-daemon protocol change: two small files in the data dir.
 */

export const VK_OWNER_SIG_HEADER = "x-bb-vk-owner-sig";
export const VK_OWNER_COOKIE = "vk_owner";
export const VK_OWNER_CLOCK_SKEW_MS = 60_000;
export const VK_OWNER_SESSION_MS = 90 * 24 * 60 * 60 * 1000;
export const VK_OWNER_PAIRING_TTL_MS = 10 * 60 * 1000;
export const VK_OWNER_PAIRING_MAX_ATTEMPTS = 5;
/** After the first key is paired, enforcement starts this much later (open tabs and a second device get their cookie). */
export const VK_OWNER_ENFORCE_GRACE_MS = 30 * 60 * 1000;

const STATE_FILE = "vk-owner.json";
const PAIRING_FILE = "vk-owner-pairing.json";
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function isVkOwnerAuthEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.BB_VK_OWNER_AUTH;
  return value === "1" || value === "true";
}

// ---------------------------------------------------------------------------
// keys and signatures

export interface VkOwnerKeyPair {
  /** PKCS8 DER, base64. Never leaves the owner's machine. */
  privateKey: string;
  /** SPKI DER, base64. What the hub stores. */
  publicKey: string;
  keyId: string;
}

export function vkOwnerKeyId(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 16);
}

export function generateVkOwnerKeyPair(): VkOwnerKeyPair {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return {
    privateKey: pair.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey,
    keyId: vkOwnerKeyId(publicKey),
  };
}

/** True for a base64 SPKI that parses as an ed25519 public key. */
export function isVkOwnerPublicKey(publicKey: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requestCanonical(args: {
  method: string;
  target: string;
  timestampMs: number;
  nonce: string;
  body: Uint8Array | undefined;
}): string {
  return [
    "vk-owner-req",
    args.method.toUpperCase(),
    args.target,
    String(args.timestampMs),
    args.nonce,
    sha256Hex(args.body ?? new Uint8Array()),
  ].join("\n");
}

function ticketCanonical(
  keyId: string,
  timestampMs: number,
  nonce: string,
): string {
  return ["vk-owner-ticket", keyId, String(timestampMs), nonce].join("\n");
}

function signDetached(privateKey: string, canonical: string): string {
  return sign(
    null,
    Buffer.from(canonical, "utf8"),
    createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    }),
  ).toString("base64url");
}

function verifyDetached(
  publicKey: string,
  canonical: string,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonical, "utf8"),
      createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export interface ParsedVkOwnerSignature {
  keyId: string;
  timestampMs: number;
  nonce: string;
  signature: string;
}

const KEY_ID_PATTERN = /^[0-9a-f]{16}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;

function parseSigned(
  value: string | undefined,
  prefix: string,
): ParsedVkOwnerSignature | null {
  if (value === undefined) return null;
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== prefix) return null;
  const [, keyId, ts, nonce, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const timestampMs = Number(ts);
  if (
    !KEY_ID_PATTERN.test(keyId) ||
    !Number.isSafeInteger(timestampMs) ||
    !NONCE_PATTERN.test(nonce) ||
    signature.length === 0
  ) {
    return null;
  }
  return { keyId, timestampMs, nonce, signature };
}

/** Header value for one request: `v1.<keyId>.<ts>.<nonce>.<ed25519 over method, target, ts, nonce, body hash>`. */
export function signVkOwnerRequest(args: {
  privateKey: string;
  keyId: string;
  method: string;
  /** Path plus query, as the server sees it (`/api/v1/...?x=1`). */
  target: string;
  body?: Uint8Array | undefined;
  now?: number;
}): string {
  const timestampMs = args.now ?? Date.now();
  const nonce = randomBytes(12).toString("base64url");
  const signature = signDetached(
    args.privateKey,
    requestCanonical({
      method: args.method,
      target: args.target,
      timestampMs,
      nonce,
      body: args.body,
    }),
  );
  return `v1.${args.keyId}.${timestampMs}.${nonce}.${signature}`;
}

export function parseVkOwnerSignature(
  value: string | undefined,
): ParsedVkOwnerSignature | null {
  return parseSigned(value, "v1");
}

export function verifyVkOwnerRequestSignature(args: {
  publicKey: string;
  parsed: ParsedVkOwnerSignature;
  method: string;
  target: string;
  body: Uint8Array | undefined;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  if (Math.abs(now - args.parsed.timestampMs) > VK_OWNER_CLOCK_SKEW_MS) {
    return false;
  }
  return verifyDetached(
    args.publicKey,
    requestCanonical({
      method: args.method,
      target: args.target,
      timestampMs: args.parsed.timestampMs,
      nonce: args.parsed.nonce,
      body: args.body,
    }),
    args.parsed.signature,
  );
}

/** One-time login ticket: `t1.<keyId>.<ts>.<nonce>.<sig>`, valid for a minute, single use. */
export function createVkOwnerTicket(args: {
  privateKey: string;
  keyId: string;
  now?: number;
}): string {
  const timestampMs = args.now ?? Date.now();
  const nonce = randomBytes(12).toString("base64url");
  const signature = signDetached(
    args.privateKey,
    ticketCanonical(args.keyId, timestampMs, nonce),
  );
  return `t1.${args.keyId}.${timestampMs}.${nonce}.${signature}`;
}

export function parseVkOwnerTicket(
  value: string | undefined,
): ParsedVkOwnerSignature | null {
  return parseSigned(value, "t1");
}

export function verifyVkOwnerTicketSignature(args: {
  publicKey: string;
  parsed: ParsedVkOwnerSignature;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  if (Math.abs(now - args.parsed.timestampMs) > VK_OWNER_CLOCK_SKEW_MS) {
    return false;
  }
  return verifyDetached(
    args.publicKey,
    ticketCanonical(
      args.parsed.keyId,
      args.parsed.timestampMs,
      args.parsed.nonce,
    ),
    args.parsed.signature,
  );
}

// ---------------------------------------------------------------------------
// hub files: paired public keys and the one-time pairing code

export interface VkOwnerKeyRecord {
  id: string;
  label: string;
  /** SPKI DER, base64. Public by design. */
  publicKey: string;
  createdAt: number;
}

export interface VkOwnerState {
  version: 1;
  /** Bumped by `revoke`: every session cookie minted before it dies. */
  epoch: number;
  keys: VkOwnerKeyRecord[];
  /**
   * Set once, when the first key is paired (now + grace). Until then the flag is
   * inert, so switching it on can never lock the owner out; after it, owner-only
   * routes need a proof even if every key is later revoked (a stolen device must
   * not reopen them). Recovery is a new pairing code from the hub shell.
   */
  enforceFrom: number | null;
}

function emptyState(): VkOwnerState {
  return { version: 1, epoch: 1, keys: [], enforceFrom: null };
}

/** Owner login is on AND past its grace: owner-only routes now demand a proof. */
export function isVkOwnerEnforced(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
  now = Date.now(),
): boolean {
  if (!isVkOwnerAuthEnabled(env)) return false;
  const { enforceFrom } = readVkOwnerState(dataDir);
  return enforceFrom !== null && now >= enforceFrom;
}

function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best effort (non-POSIX file systems).
  }
  renameSync(tmp, path);
}

export function readVkOwnerState(dataDir: string): VkOwnerState {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8")) as
      | Partial<VkOwnerState>
      | null;
    if (raw === null || typeof raw !== "object" || !Array.isArray(raw.keys)) {
      return emptyState();
    }
    const keys = raw.keys.filter(
      (key): key is VkOwnerKeyRecord =>
        typeof key?.id === "string" &&
        typeof key.publicKey === "string" &&
        vkOwnerKeyId(key.publicKey) === key.id &&
        isVkOwnerPublicKey(key.publicKey),
    );
    return {
      version: 1,
      epoch:
        typeof raw.epoch === "number" && Number.isSafeInteger(raw.epoch)
          ? raw.epoch
          : 1,
      keys,
      enforceFrom:
        typeof raw.enforceFrom === "number" && Number.isFinite(raw.enforceFrom)
          ? raw.enforceFrom
          : null,
    };
  } catch {
    return emptyState();
  }
}

export function writeVkOwnerState(dataDir: string, state: VkOwnerState): void {
  mkdirSync(dataDir, { recursive: true });
  writePrivateFile(
    join(dataDir, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export function addVkOwnerKey(
  dataDir: string,
  args: { publicKey: string; label: string; now?: number },
): VkOwnerKeyRecord {
  const state = readVkOwnerState(dataDir);
  const id = vkOwnerKeyId(args.publicKey);
  const record: VkOwnerKeyRecord = {
    id,
    label: args.label.slice(0, 80),
    publicKey: args.publicKey,
    createdAt: args.now ?? Date.now(),
  };
  writeVkOwnerState(dataDir, {
    ...state,
    keys: [...state.keys.filter((key) => key.id !== id), record],
    enforceFrom:
      state.enforceFrom ?? record.createdAt + VK_OWNER_ENFORCE_GRACE_MS,
  });
  return record;
}

/** Removes every paired key and bumps the epoch: all sessions and signatures stop working. Enforcement stays. */
export function revokeVkOwnerKeys(dataDir: string): void {
  const state = readVkOwnerState(dataDir);
  writeVkOwnerState(dataDir, {
    version: 1,
    epoch: state.epoch + 1,
    keys: [],
    enforceFrom: state.enforceFrom,
  });
  rmSync(join(dataDir, PAIRING_FILE), { force: true });
}

/** Removes one paired key (a lost device) and ends the sessions minted for it. */
export function removeVkOwnerKey(dataDir: string, keyId: string): boolean {
  const state = readVkOwnerState(dataDir);
  if (!state.keys.some((key) => key.id === keyId)) return false;
  writeVkOwnerState(dataDir, {
    ...state,
    keys: state.keys.filter((key) => key.id !== keyId),
  });
  return true;
}

function pairingHash(code: string): string {
  return sha256Hex(`vk-owner-pairing:${code.toUpperCase().replace(/[^A-Z0-9]/gu, "")}`);
}

/** Hub-local: mints a one-time pairing code (shown once, stored as a hash, 10 minutes). */
export function createVkOwnerPairingCode(
  dataDir: string,
  now = Date.now(),
): { code: string; expiresAt: number } {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) {
    code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  }
  const expiresAt = now + VK_OWNER_PAIRING_TTL_MS;
  mkdirSync(dataDir, { recursive: true });
  writePrivateFile(
    join(dataDir, PAIRING_FILE),
    JSON.stringify({ codeSha256: pairingHash(code), expiresAt, attempts: 0 }),
  );
  return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt };
}

export type VkOwnerPairingResult =
  | "ok"
  | "none"
  | "expired"
  | "invalid"
  | "locked";

export function consumeVkOwnerPairingCode(
  dataDir: string,
  code: string,
  now = Date.now(),
): VkOwnerPairingResult {
  const path = join(dataDir, PAIRING_FILE);
  let pending: { codeSha256: string; expiresAt: number; attempts: number };
  try {
    pending = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "none";
  }
  if (
    typeof pending.codeSha256 !== "string" ||
    typeof pending.expiresAt !== "number" ||
    pending.expiresAt < now
  ) {
    rmSync(path, { force: true });
    return "expired";
  }
  const presented = Buffer.from(pairingHash(code));
  const expected = Buffer.from(pending.codeSha256);
  if (
    presented.length === expected.length &&
    timingSafeEqual(presented, expected)
  ) {
    rmSync(path, { force: true });
    return "ok";
  }
  const attempts = (pending.attempts ?? 0) + 1;
  if (attempts >= VK_OWNER_PAIRING_MAX_ATTEMPTS) {
    rmSync(path, { force: true });
    return "locked";
  }
  writePrivateFile(path, JSON.stringify({ ...pending, attempts }));
  return "invalid";
}
