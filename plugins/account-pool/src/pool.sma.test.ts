import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { accountSchema, statusReportSchema } from "./contracts.js";
import { createAccountPoolPlugin } from "./server.js";
import { AccountStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function sdkStubs() {
  return {
    hosts: {
      list: async () => [
        { id: "host-one", name: "One" },
        { id: "host-two", name: "Two" },
      ],
    },
    threads: { events: { list: async () => [] } },
    system: { providerStates: async () => ({ providers: [] }) },
    plugins: {
      list: async () => ({ plugins: [{ id: "account-pool", enabled: true }] }),
    },
  };
}

async function pool() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-sma-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: sdkStubs(),
  });
  await createAccountPoolPlugin()(host.bb);
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { host, dataDir };
}

async function secretFiles(dataDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^account-.*\.json$/u.test(entry.name)) found.push(full);
    }
  };
  await walk(dataDir);
  return found;
}

describe("account pool (SMA proofs)", () => {
  it("[sma:m_ac_add] an API-key account enters the pool through the add operation only: the key goes to the secret store, never into the account record, and Codex takes no API key", async () => {
    const { host, dataDir } = await pool();
    const added = accountSchema.parse(
      await host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        apiKey: "sk-secret-marker-596", // guardian: allow
        label: null,
        priority: 100,
      }),
    );
    expect(added.kind).toBe("api-key");
    expect(added.provider).toBe("claude");
    expect(added.label).toBe("Claude API key");
    expect(JSON.stringify(added)).not.toContain("sk-secret-marker-596");
    expect(
      JSON.stringify(await host.bb.storage.kv.get("accounts:v1")),
    ).not.toContain("sk-secret-marker-596");
    const files = await secretFiles(dataDir);
    expect(files).toHaveLength(1);
    expect(path.basename(files[0] ?? "")).toBe(`account-${added.id}.json`);
    expect(await fs.readFile(files[0] ?? "", "utf8")).toContain(
      "sk-secret-marker-596",
    );
    const codexKey = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--api-key",
      "sk-codex",
    ]);
    expect(codexKey.exitCode).toBe(1);
    expect(codexKey.stderr).toContain(
      "Anthropic API keys require --provider claude",
    );
    expect(await secretFiles(dataDir)).toHaveLength(1);
  });

  it("[sma:d_account_add] the add command stores the account with the given label and priority, answers without the key and lists the account in the pool status", async () => {
    const { host } = await pool();
    const result = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--api-key",
      "sk-cli-secret-812",
      "--label",
      "Night account",
      "--priority",
      "7",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("sk-cli-secret-812");
    const status = await host.harness.behavior.runCli(["status", "--json"]);
    const report = statusReportSchema.parse(JSON.parse(status.stdout));
    expect(
      report.accounts.map((account) => ({
        label: account.label,
        priority: account.priority,
        provider: account.provider,
        kind: account.kind,
      })),
    ).toEqual([
      {
        label: "Night account",
        priority: 7,
        provider: "claude",
        kind: "api-key",
      },
    ]);
  });

  it("[sma:m_ac_env] the launch environment of a thread carries the hub address and a per-machine hub token, never the account's own key", async () => {
    const { host } = await pool();
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      apiKey: "sk-secret-marker-597", // guardian: allow
      label: null,
      priority: 100,
    });
    const ctx = (hostId: string) => ({
      threadId: "thread-one",
      projectId: "project-one",
      hostId,
    });
    const one = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      ctx("host-one"),
    );
    const two = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      ctx("host-two"),
    );
    const tokenOf = (entries: typeof one) =>
      entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value;
    expect(tokenOf(one)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(tokenOf(two)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(tokenOf(one)).not.toBe(tokenOf(two));
    expect(
      one.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool/http" });
    expect(JSON.stringify(one)).not.toContain("sk-secret-marker-597");
    const codex = await host.harness.behavior.resolveProviderEnv(
      "codex",
      ctx("host-one"),
    );
    expect(codex).toEqual([]);
  });

  it("[sma:m_ac_config_dir] an account's secret is written to its own file with owner-only access and a session cannot name another path through the id", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-secret-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    cleanups.push(() => host.harness.lifecycle.dispose());
    const secretsDir = path.join(dataDir, "secrets");
    const store = new AccountStore(host.bb.storage.kv, secretsDir);
    const idA = "11111111-1111-4111-8111-111111111111";
    const idB = "22222222-2222-4222-8222-222222222222";
    await store.writeSecret(idA, { kind: "api-key", apiKey: "key-for-a" });
    await store.writeSecret(idB, { kind: "api-key", apiKey: "key-for-b" });
    const fileA = path.join(secretsDir, `account-${idA}.json`);
    const fileB = path.join(secretsDir, `account-${idB}.json`);
    expect(JSON.parse(await fs.readFile(fileA, "utf8"))).toEqual({
      kind: "api-key",
      apiKey: "key-for-a",
    });
    expect(JSON.parse(await fs.readFile(fileB, "utf8"))).toEqual({
      kind: "api-key",
      apiKey: "key-for-b",
    });
    expect((await fs.stat(fileA)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(secretsDir)).mode & 0o777).toBe(0o700);
    await expect(
      store.writeSecret("../escape", { kind: "api-key", apiKey: "x" }),
    ).rejects.toThrow();
    expect((await fs.readdir(secretsDir)).sort()).toEqual([
      `account-${idA}.json`,
      `account-${idB}.json`,
    ]);
  });
});
