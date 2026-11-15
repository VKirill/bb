import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../ai/ai-service-registry.js";
import { createNoopTelemetryService } from "../system/telemetry.js";
import { createPluginService, type PluginService } from "./plugin-service.js";
import { testLogger } from "../../../test/helpers/test-app.js";

// SMA map, region 5 «Daemon boot», n470 «Could not start» (m_boot_fail): a start that fails is explained, not swallowed.
// In BB the plugin's start is the core loading its server factory; Lane Pilot's database is SQLite that BB opens, so the
// failure the person must see is the plugin's own start error, as the runtime status `error` with the reason text.

const logger = testLogger as unknown as Logger;

async function writePlugin(dir: string, name: string, serverSource: string): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      bb: {
        name: "Boot failure fixture",
        description: "A plugin for the start failure proof.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), serverSource);
  return rootDir;
}

describe("a plugin that could not start (core: plugin-runtime loadOne)", () => {
  let workDir = "";
  let service: PluginService;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sma-boot-fail-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db: createMigratedConnection(),
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginChanged: () => {},
        onWatchedTargets: () => () => {},
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 5_000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("[sma:m_boot_fail] a start that throws leaves the plugin in status error with the reason as its detail, and the other plugins keep running", async () => {
    const reason = "could not open the plugin database data.db: SQLITE_CANTOPEN";
    const healthy = await service.installPath(
      await writePlugin(workDir, "bb-plugin-sma-healthy", "export default function plugin() {}"),
    );
    const broken = await service.installPath(
      await writePlugin(
        workDir,
        "bb-plugin-sma-broken",
        `export default function plugin() { throw new Error(${JSON.stringify(reason)}); }`,
      ),
    );

    expect(healthy.status).toBe("running");
    expect({ status: broken.status, detail: broken.statusDetail }).toEqual({ status: "error", detail: reason });

    // The listing every BB surface reads (window, `bb plugin list`) says the same, and the healthy plugin is untouched.
    const listed = new Map(service.list().map((entry) => [entry.id, entry]));
    expect({ status: listed.get(broken.id)?.status, detail: listed.get(broken.id)?.statusDetail }).toEqual({ status: "error", detail: reason });
    expect(listed.get(healthy.id)?.status).toBe("running");
  });
});
