import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getInstalledPlugin,
  getPluginSettingsValues,
  listPluginSchedules,
  setPluginSettingsValues,
  upsertPluginSchedule,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../src/services/plugins/plugin-service.js";
import { pluginSecretsDir } from "../../src/services/plugins/plugin-settings.js";
import { createNoopTelemetryService } from "../../src/services/system/telemetry.js";
import { testLogger } from "../helpers/test-app.js";

const run = promisify(execFile);
const logger = testLogger as unknown as Logger;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

async function commitPlugin(repo: string, version: string): Promise<string> {
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "bb-plugin-updater",
      version,
      bb: {
        name: "Updater fixture",
        description: "Plugin update fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(repo, "server.ts"),
    `export default function plugin(bb: { log: { info(message: string): void } }) { bb.log.info(${JSON.stringify(version)}); }`,
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", version]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("plugin update check and apply (core: plugin-updates)", () => {
  let db: DbConnection;
  let workDir: string;
  let repo: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createMigratedConnection();
    workDir = await mkdtemp(join(tmpdir(), "sma-plugin-updates-"));
    repo = join(workDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await commitPlugin(repo, "1.0.0");
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginChanged: () => {},
        onWatchedTargets: () => () => {},
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      loadTimeoutMs: 2000,
      stabilizationWindowMs: 0,
    });
    await service.install(`git:${repo}@main`, { kind: "root" });
  });

  afterEach(async () => {
    await service.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("[sma:k_up_cmd] a check reports the versions and installs nothing; the update goes through the installer and moves the plugin to the new version; a pinned plugin refuses", async () => {
    // up to date: reported, nothing to do
    const first = await service.checkForUpdates("updater");
    expect(first).toMatchObject([{ id: "updater", outcome: "current" }]);
    const installedCommit = getInstalledPlugin(db, "updater")?.gitResolvedCommit;
    expect(installedCommit).toMatch(/^[0-9a-f]{40}$/u);

    // a newer commit appears: the check names it and changes nothing on disk or in the register
    const candidate = await commitPlugin(repo, "1.1.0");
    const checked = await service.checkForUpdates("updater");
    expect(checked).toMatchObject([
      { id: "updater", outcome: "update-available", candidate: { version: candidate } },
    ]);
    expect(checked[0]?.installed.version).toBe(installedCommit);
    const afterCheck = getInstalledPlugin(db, "updater");
    expect(afterCheck?.gitResolvedCommit).toBe(installedCommit);
    expect(afterCheck?.version).toBe("1.0.0");
    expect(afterCheck?.availableCompatibleVersion).toBe(candidate);
    expect(service.listUpdateResults()).toMatchObject([
      { id: "updater", outcome: "update-available", candidate: { version: candidate } },
    ]);

    // the update itself
    const applied = await service.applyUpdate("updater");
    expect(applied).toMatchObject({
      ok: true,
      result: { applied: true, outcome: "updated", to: { version: candidate } },
    });
    const afterApply = getInstalledPlugin(db, "updater");
    expect(afterApply?.gitResolvedCommit).toBe(candidate);
    expect(afterApply?.version).toBe("1.1.0");
    expect(await service.checkForUpdates("updater")).toMatchObject([{ outcome: "current" }]);

    // a plugin pinned to a tag has no channel to update through
    await git(repo, ["tag", "v1"]);
    await service.remove("updater");
    await service.install(`git:${repo}@v1`, { kind: "root" });
    expect(await service.applyUpdate("updater")).toEqual({
      ok: false,
      error:
        'plugin "updater" is pinned by its source intent; remove and reinstall it with an npm range, a git branch, or a git semver range to track updates',
    });
  });

  it("[sma:k_rm_self] removing a plugin deletes its settings, schedules and secrets, and after a restart nothing of it is listed or loaded", async () => {
    const secretsDir = pluginSecretsDir(join(workDir, "data"), "updater");
    setPluginSettingsValues(db, "updater", { mode: JSON.stringify("mine") });
    upsertPluginSchedule(db, { pluginId: "updater", name: "nightly", cron: "0 * * * *", nextRunAt: 99 });
    await mkdir(secretsDir, { recursive: true });
    await writeFile(join(secretsDir, "token"), "s3cret", { mode: 0o600 });
    expect(getInstalledPlugin(db, "updater")).not.toBeUndefined();
    expect(listPluginSchedules(db, "updater")).toHaveLength(1);

    await service.remove("updater");

    expect(getInstalledPlugin(db, "updater")).toBeUndefined();
    expect(getPluginSettingsValues(db, "updater")).toEqual({});
    expect(listPluginSchedules(db, "updater")).toEqual([]);
    await expect(access(secretsDir)).rejects.toThrow();
    expect(service.list().map((plugin) => plugin.id)).not.toContain("updater");

    // a restart of the service on the same database and data folder brings nothing back
    await service.stop();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginChanged: () => {},
        onWatchedTargets: () => () => {},
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      loadTimeoutMs: 2000,
      stabilizationWindowMs: 0,
    });
    await service.start();
    expect(service.list().map((plugin) => plugin.id)).not.toContain("updater");
    expect(service.getApi("updater")).toBeUndefined();
    expect(listPluginSchedules(db, "updater")).toEqual([]);
  });
});
