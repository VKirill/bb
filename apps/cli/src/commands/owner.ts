import { execFile } from "node:child_process";
import { hostname, platform } from "node:os";
import { Command } from "commander";
import {
  createVkOwnerPairingCode,
  createVkOwnerTicket,
  removeVkOwnerKey,
  revokeVkOwnerKeys,
} from "@bb/config/vk-owner-auth";
import { action, CliExitError } from "../action.js";
import { cliFetch } from "../client.js";
import {
  createOwnerKey,
  defaultOwnerKeyStore,
  loadOwnerKey,
} from "../vk-owner-key.js";
import { outputJson } from "./helpers.js";
import { resolveLocalDataDir } from "./server-local.js";

// VK EXPERIMENTAL: owner login (opt-in on the hub with BB_VK_OWNER_AUTH=1). See VK_PATCHES.md.

interface OwnerOptions {
  json?: boolean;
  dataDir?: string;
  label?: string;
  code?: string;
  url?: string;
  print?: boolean;
  force?: boolean;
  login?: boolean;
}

async function hubJson(
  url: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await cliFetch(`${url}/api/v1${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Not JSON: fall through to the status line.
  }
  if (!response.ok) {
    const message =
      typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
    throw new CliExitError(message, 1);
  }
  return body;
}

function openInBrowser(url: string): void {
  const opener = platform() === "darwin" ? "open" : "xdg-open";
  execFile(opener, [url], () => undefined);
}

export function registerOwnerCommands(
  program: Command,
  getUrl: () => string,
): void {
  const owner = program
    .command("owner")
    .description(
      "Owner login for the hub (VK): pair this machine once, then sign in the web app",
    );

  owner
    .command("init")
    .description("Create the owner key on this machine (Keychain on macOS, 0600 file elsewhere)")
    .option("--force", "Replace an existing key")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: OwnerOptions) => {
        const store = defaultOwnerKeyStore();
        const existing = loadOwnerKey(store);
        if (existing !== null && opts.force !== true) {
          throw new CliExitError(
            `An owner key already exists (id ${existing.keyId}). Use --force to replace it.`,
            1,
          );
        }
        const key = createOwnerKey(store);
        const result = { keyId: key.keyId, publicKey: key.publicKey, storedIn: store.describe() };
        if (outputJson(opts, result)) return;
        console.log(`Owner key ${key.keyId} created.\nStored in ${result.storedIn}.`);
        console.log("Next: on the hub run `bb owner pairing-code`, then here `bb owner pair --code <code>`.");
      }),
    );

  owner
    .command("pair")
    .description("Register this machine's owner key on the hub with the one-time code from `bb owner pairing-code`")
    .requiredOption("--code <code>", "Pairing code shown on the hub")
    .option("--label <label>", "Name of this machine", hostname())
    .option("--url <url>", "Public URL of the hub as the browser reaches it (default: the CLI's server URL)")
    .option("--no-login", "Do not open the web app signed in after pairing")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: OwnerOptions) => {
        const store = defaultOwnerKeyStore();
        const key = loadOwnerKey(store) ?? createOwnerKey(store);
        const body = await hubJson(getUrl(), "/vk/owner/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: opts.code,
            publicKey: key.publicKey,
            label: opts.label,
          }),
        });
        const result = { ok: true, keyId: body.keyId ?? key.keyId, enforceFrom: body.enforceFrom ?? null };
        if (outputJson(opts, result)) return;
        console.log(`Paired. Key ${key.keyId} is now trusted by the hub.`);
        if (opts.login !== false) {
          // Signs the browser in right away, so the tab that is already open keeps working.
          const base = (opts.url ?? getUrl()).replace(/\/+$/u, "");
          const ticket = createVkOwnerTicket({ privateKey: key.privateKey, keyId: key.keyId });
          openInBrowser(`${base}/api/v1/vk/owner/session?ticket=${encodeURIComponent(ticket)}`);
          console.log(`Opened ${base} signed in. For another browser or a phone: bb owner login --print --url <public URL>.`);
        }
      }),
    );

  owner
    .command("login")
    .description("Open the web app signed in as the owner (one-time ticket, then a 90-day session cookie)")
    .option("--url <url>", "Public URL of the hub as the browser reaches it (default: the CLI's server URL)")
    .option("--print", "Print the sign-in link instead of opening a browser")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: OwnerOptions) => {
        const key = loadOwnerKey();
        if (key === null) {
          throw new CliExitError("No owner key on this machine. Run `bb owner init` and `bb owner pair`.", 1);
        }
        const base = (opts.url ?? getUrl()).replace(/\/+$/u, "");
        const ticket = createVkOwnerTicket({ privateKey: key.privateKey, keyId: key.keyId });
        const link = `${base}/api/v1/vk/owner/session?ticket=${encodeURIComponent(ticket)}`;
        if (opts.print === true || opts.json === true) {
          if (outputJson(opts, { link, validForSeconds: 60 })) return;
          console.log(link);
          return;
        }
        openInBrowser(link);
        console.log(`Opened ${base} in your browser. The link works once, for 60 seconds.`);
      }),
    );

  owner
    .command("status")
    .description("Show whether this machine has an owner key and what the hub says")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: OwnerOptions) => {
        const key = loadOwnerKey();
        const hub = await hubJson(getUrl(), "/vk/owner/status");
        const result = { keyId: key?.keyId ?? null, hub };
        if (outputJson(opts, result)) return;
        console.log(`Owner key on this machine: ${key?.keyId ?? "none"}`);
        console.log(
          `Hub: login ${hub.enabled === true ? (hub.enforced === true ? "ON and enforced" : "ON, not enforced yet (grace or nothing paired)") : "off"}, ${hub.paired === true ? "a key is paired" : "no key paired"}, this request ${hub.owner === true ? "is" : "is not"} the owner`,
        );
      }),
    );

  owner
    .command("pairing-code")
    .description("Hub only: mint a one-time pairing code (10 minutes, stored as a hash)")
    .option("--data-dir <path>", "BB data directory of the hub")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: OwnerOptions) => {
        const dataDir = resolveLocalDataDir(opts.dataDir);
        const minted = createVkOwnerPairingCode(dataDir);
        if (outputJson(opts, minted)) return;
        console.log(`Pairing code: ${minted.code}\nValid for 10 minutes, 5 attempts. On the owner's machine: bb owner pair --code ${minted.code}`);
      }),
    );

  owner
    .command("remove-key <keyId>")
    .description("Hub only: remove one paired key (a lost device) and end its sessions")
    .option("--data-dir <path>", "BB data directory of the hub")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (keyId: string, opts: OwnerOptions) => {
        const dataDir = resolveLocalDataDir(opts.dataDir);
        if (!removeVkOwnerKey(dataDir, keyId)) {
          throw new CliExitError(`No paired key ${keyId} in ${dataDir}.`, 1);
        }
        // Sessions are tied to the key id, so its cookies stop working at once.
        if (outputJson(opts, { ok: true, keyId })) return;
        console.log(`Key ${keyId} removed.`);
      }),
    );

  owner
    .command("revoke")
    .description("Hub only: remove every paired owner key and end all owner sessions")
    .option("--data-dir <path>", "BB data directory of the hub")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: OwnerOptions) => {
        const dataDir = resolveLocalDataDir(opts.dataDir);
        revokeVkOwnerKeys(dataDir);
        if (outputJson(opts, { ok: true, dataDir })) return;
        console.log(`All owner keys and sessions in ${dataDir} are revoked.`);
      }),
    );
}
