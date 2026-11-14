import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVkOwnerTicket, verifyVkOwnerTicketSignature } from "@bb/config/vk-owner-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../__tests__/helpers/command-output-harness.js";
import { createFileStore, createOwnerKey, ownerKeyFilePath } from "../vk-owner-key.js";
import { registerOwnerCommands } from "./owner.js";

// SMA map, region 5 «Daemon boot», n469 «Window entry link» (m_entry_link): «The address and token exchange go to the
// person's console, never into a log file.» The console half: `bb owner login --print` prints the sign-in link with its
// one-time ticket to the person's terminal and nowhere else (no request carries it); the hub's half (the ticket traded
// once, nothing logged) is the [sma:m_entry_link] test beside apps/server/src/services/plugins/vk-owner-auth.ts.

describe("bb owner login --print (core: apps/cli owner)", () => {
  setupCommandOutputTestEnvironment();
  let configHome = "";
  let savedXdg: string | undefined;

  beforeEach(async () => {
    configHome = await mkdtemp(join(tmpdir(), "sma-owner-login-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(async () => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    await rm(configHome, { recursive: true, force: true });
  });

  const register: CommandRegistrar = (program) => registerOwnerCommands(program, () => "http://server");

  it.skipIf(process.platform === "darwin")("[sma:m_entry_link] the sign-in link with its one-time ticket is printed to the person's console, once, and is sent nowhere", async () => {
    const key = createOwnerKey(createFileStore(ownerKeyFilePath(undefined, configHome)));

    await runCommand(["owner", "login", "--print", "--url", "https://hub.example/"], register);

    const lines = collectLogLines(vi.mocked(console.log));
    expect(lines).toHaveLength(1);
    const link = new URL(lines[0] ?? "");
    expect(`${link.origin}${link.pathname}`).toBe("https://hub.example/api/v1/vk/owner/session");
    const parsed = parseVkOwnerTicket(link.searchParams.get("ticket") ?? undefined);
    expect(parsed?.keyId).toBe(key.keyId);
    expect(parsed !== null && verifyVkOwnerTicketSignature({ publicKey: key.publicKey, parsed })).toBe(true);
    // Minted on this machine: the ticket goes to no server and into no error output.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });
});
