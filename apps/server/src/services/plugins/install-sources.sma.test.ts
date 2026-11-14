import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../ai/ai-service-registry.js";
import { createNoopTelemetryService } from "../system/telemetry.js";
import { parsePluginSource } from "./install-sources.js";
import { createPluginService, type PluginService } from "./plugin-service.js";
import { testLogger } from "../../../test/helpers/test-app.js";

// SMA map, region 19 «Update», n1514 «Local product checkout nearby» (k_up_local): the update can come from a product
// checkout on the machine instead of the registry. In BB that is the `path:` source: the person names the folder once,
// the plugin runs from it, and a reload reads that folder again (nothing looks for a folder on its own).

const logger = testLogger as unknown as Logger;

async function writeCheckout(rootDir: string, version: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-sma-local",
      version,
      bb: {
        name: "Local checkout fixture",
        description: "A plugin run from a local folder.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), "export default function plugin() {}");
}

describe("a plugin from a local product checkout (core: install-sources parsePluginSource)", () => {
  let workDir = "";
  let service: PluginService;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "sma-local-checkout-"));
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

  it("[sma:k_up_local] a path: source is that local folder, the plugin runs from it, and a reload takes the folder's new version", async () => {
    const checkout = join(workDir, "plugins", "bb-plugin-sma-local");
    await writeCheckout(checkout, "0.1.0");

    // Only the named folder is a local source; a registry or git source never turns into one.
    expect(parsePluginSource(`path:${checkout}`)).toEqual({ kind: "path", path: checkout });
    expect(parsePluginSource(checkout)).toEqual({ kind: "path", path: checkout });
    expect(parsePluginSource("npm:bb-plugin-sma-local@0.1.0").kind).toBe("npm");
    expect(parsePluginSource("git:https://example.invalid/bb-plugin-sma-local.git").kind).toBe("git");

    const installed = await service.install(`path:${checkout}`, { kind: "root" });
    expect({ rootDir: installed.rootDir, version: installed.version, status: installed.status }).toEqual({
      rootDir: checkout,
      version: "0.1.0",
      status: "running",
    });

    // The checkout moves on: the next reload runs what the folder now holds.
    await writeCheckout(checkout, "0.2.0");
    await service.reload(installed.id);
    const after = service.list().find((entry) => entry.id === installed.id);
    expect({ rootDir: after?.rootDir, version: after?.version, status: after?.status }).toEqual({
      rootDir: checkout,
      version: "0.2.0",
      status: "running",
    });
  });
});
