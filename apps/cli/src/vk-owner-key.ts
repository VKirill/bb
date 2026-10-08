import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import {
  generateVkOwnerKeyPair,
  signVkOwnerRequest,
  vkOwnerKeyId,
  VK_OWNER_SIG_HEADER,
} from "@bb/config/vk-owner-auth";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Where the owner's private key lives on THIS machine, and how the CLI signs with it.
 * Never an environment variable (host-daemon-spawned agents inherit env, and `ps`
 * shows it). macOS: a login-keychain item created with an empty trusted-application
 * list (`-T ""`), so every read by any process, including `security` itself, raises
 * the keychain password prompt; a headless agent (SSH, launchd without a GUI) cannot
 * answer it. Elsewhere: a 0600 file in a 0700 directory under the user's config dir,
 * outside every work folder. The file is readable by processes of the same OS user:
 * keep it off machines where agents run as that user (see VK_PATCHES.md).
 */

export interface VkOwnerKeyStore {
  describe(): string;
  read(): string | null;
  write(privateKey: string): void;
  remove(): void;
}

const KEYCHAIN_SERVICE = "bb-vk-owner";
const KEYCHAIN_ACCOUNT = "bb-owner";

export function createKeychainStore(
  exec: typeof execFileSync = execFileSync,
): VkOwnerKeyStore {
  return {
    describe: () =>
      `macOS Keychain item "${KEYCHAIN_SERVICE}" (asks for the keychain password on every read)`,
    read() {
      try {
        const out = exec(
          "security",
          ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 },
        );
        const value = String(out).trim();
        return value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    write(privateKey) {
      // `-T ""`: no application is trusted, so even `security` prompts on each read.
      // The key is in argv for the instant of this one-time call (own machine, own user).
      exec(
        "security",
        [
          "add-generic-password",
          "-U",
          "-s", KEYCHAIN_SERVICE,
          "-a", KEYCHAIN_ACCOUNT,
          "-T", "",
          "-w", privateKey,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    },
    remove() {
      try {
        exec(
          "security",
          ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
          { stdio: "ignore" },
        );
      } catch {
        // Nothing stored.
      }
    },
  };
}

export function ownerKeyFilePath(
  home = homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  const base =
    xdgConfigHome !== undefined && xdgConfigHome.length > 0
      ? xdgConfigHome
      : join(home, ".config");
  return join(base, "bb-owner", "owner.key");
}

export function createFileStore(path: string): VkOwnerKeyStore {
  return {
    describe: () => `file ${path} (mode 0600; readable by this OS user's processes)`,
    read() {
      try {
        // A key file other users can read is as good as published: refuse it.
        if ((statSync(path).mode & 0o077) !== 0) return null;
        const value = readFileSync(path, "utf8").trim();
        return value.length > 0 ? value : null;
      } catch {
        return null;
      }
    },
    write(privateKey) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${privateKey}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    remove() {
      rmSync(path, { force: true });
    },
  };
}

export function defaultOwnerKeyStore(): VkOwnerKeyStore {
  return platform() === "darwin"
    ? createKeychainStore()
    : createFileStore(ownerKeyFilePath());
}

export interface VkOwnerKey {
  privateKey: string;
  publicKey: string;
  keyId: string;
}

function fromPrivate(privateKey: string): VkOwnerKey {
  const publicKey = createPublicKey(
    createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    }),
  )
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return { privateKey, publicKey, keyId: vkOwnerKeyId(publicKey) };
}

export function loadOwnerKey(
  store: VkOwnerKeyStore = defaultOwnerKeyStore(),
): VkOwnerKey | null {
  const stored = store.read();
  if (stored === null) return null;
  try {
    return fromPrivate(stored);
  } catch {
    return null;
  }
}

export function createOwnerKey(store: VkOwnerKeyStore = defaultOwnerKeyStore()): VkOwnerKey {
  const pair = generateVkOwnerKeyPair();
  store.write(pair.privateKey);
  return pair;
}

/** Requests the hub treats as owner-only when login is on (mirrors the server's list). */
export function isOwnerSignedRequest(method: string, url: URL): boolean {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return false;
  const path = url.pathname;
  if (!path.startsWith("/api/v1/")) return false;
  const below = path.slice("/api/v1".length);
  return (
    /^\/(?:plugins|plugin-catalog|marketplaces|files)(?:\/|$)/u.test(below) ||
    /^\/threads\/[^/]+\/interactions\//u.test(below)
  );
}

/**
 * Header that signs one request with the owner key, or null: wrong request kind, an
 * agent session (the owner's key is never used from inside one), or no key here.
 */
export function ownerSignatureHeaders(args: {
  method: string;
  url: URL;
  body: Uint8Array | undefined;
  env?: Record<string, string | undefined>;
  store?: VkOwnerKeyStore;
  now?: number;
}): Record<string, string> | null {
  const env = args.env ?? process.env;
  if (env.BB_THREAD_ID || env.BB_VK_THREAD_TOKEN) return null;
  if (!isOwnerSignedRequest(args.method, args.url)) return null;
  const key = loadOwnerKey(args.store);
  if (key === null) return null;
  return {
    [VK_OWNER_SIG_HEADER]: signVkOwnerRequest({
      privateKey: key.privateKey,
      keyId: key.keyId,
      method: args.method,
      target: `${args.url.pathname}${args.url.search}`,
      body: args.body,
      ...(args.now === undefined ? {} : { now: args.now }),
    }),
  };
}
