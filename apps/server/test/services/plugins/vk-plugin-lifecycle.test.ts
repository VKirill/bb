import {
  createConnection,
  getPluginKvValue,
  migrate,
  upsertInstalledPlugin,
  getInstalledPlugin,
} from "@bb/db";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ExperimentalVkPluginLifecycleContext } from "@get-bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import {
  runVkPluginLifecycle,
  createVkPluginLifecycleRunner,
} from "../../../src/services/plugins/vk-plugin-lifecycle.js";
import type { PluginHostArtifactSnapshot } from "../../../src/services/plugins/plugin-service-internal.js";

it("shares a temporary artifact across concurrent cleanup calls and disposes it after both finish", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "vk-lifecycle-"));
  const db = createConnection(":memory:");
  migrate(db);
  try {
    await writeFile(
      join(rootDir, "server.ts"),
      "export default function plugin() {}",
    );
    await writeFile(
      join(rootDir, "host.ts"),
      "export default function host() {}",
    );
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-cleanup",
        version: "0.1.0",
        bb: {
          name: "Cleanup",
          description: "Fixture",
          branding: { icon: "Zap" },
          server: "./server.ts",
          host: "./host.ts",
        },
      }),
    );
    upsertInstalledPlugin(db, {
      id: "cleanup",
      source: `path:${rootDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: rootDir },
      exactResolution: { kind: "path" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir,
      version: "0.1.0",
      enabled: false,
    });
    const artifact = {
      path: "host.mjs",
      digest: "digest",
      generation: "generation",
      byteLength: 1,
    };
    const hostArtifacts = new Map<string, PluginHostArtifactSnapshot>();
    const loadHostArtifact = vi.fn(async () => {
      await Promise.resolve();
      return artifact;
    });
    const contract = defineRpcContract({
      cleanup: { input: z.object({}), output: z.object({}) },
    });
    const trace: string[] = [];
    const runner = createVkPluginLifecycleRunner({
      db,
      hostArtifacts,
      loadHostArtifact,
      importModule: async () => ({
        experimental_vkLifecycle: async (
          ctx: ExperimentalVkPluginLifecycleContext,
        ) => {
          await Promise.all(
            ["host-a", "host-b"].map((hostId) =>
              ctx.callHost({ contract, method: "cleanup", input: {}, hostId }),
            ),
          );
        },
      }),
      callPluginHost: async ({ hostId }) => {
        expect(runner.lifecyclePluginIds.has("cleanup")).toBe(true);
        expect(hostArtifacts.get("cleanup")).toBe(artifact);
        trace.push(hostId);
        return {};
      },
      disposePluginHost: async () => {
        trace.push("disposed");
      },
    });
    await runner.runLifecycle(getInstalledPlugin(db, "cleanup")!, "remove");
    expect(loadHostArtifact).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(["host-a", "host-b", "disposed"]);
    expect(hostArtifacts.size).toBe(0);
    expect(runner.lifecyclePluginIds.size).toBe(0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

it("persists retry progress and prevents a missing cleanup export from silently succeeding", async () => {
  const db = createConnection(":memory:");
  migrate(db);
  const input = {
    db,
    pluginId: "test",
    action: "remove" as const,
    callHost: vi.fn(),
  };
  await expect(
    runVkPluginLifecycle({
      ...input,
      module: {
        experimental_vkLifecycle: async (
          ctx: ExperimentalVkPluginLifecycleContext,
        ) => {
          await ctx.kv.set("progress", { host: "offline" });
          throw new Error("host offline");
        },
      },
    }),
  ).rejects.toThrow("host offline");
  expect(JSON.parse(getPluginKvValue(db, "test", "progress")!)).toEqual({
    host: "offline",
  });
  await expect(runVkPluginLifecycle({ ...input, module: {} })).rejects.toThrow(
    "export is missing",
  );
});

it("expires timed-out contexts and aborts host calls", async () => {
  const db = createConnection(":memory:");
  migrate(db);
  const saved: { context?: ExperimentalVkPluginLifecycleContext } = {};
  await expect(
    runVkPluginLifecycle({
      db,
      pluginId: "timeout",
      action: "disable",
      callHost: vi.fn(),
      timeoutMs: 10,
      module: {
        experimental_vkLifecycle: (
          ctx: ExperimentalVkPluginLifecycleContext,
        ) => {
          saved.context = ctx;
          return new Promise<void>(() => {});
        },
      },
    }),
  ).rejects.toThrow("timed out");
  expect(saved.context?.signal.aborted).toBe(true);
  await expect(saved.context!.kv.set("late", true)).rejects.toThrow("expired");
  expect(getPluginKvValue(db, "timeout", "late")).toBeUndefined();
});
