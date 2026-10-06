import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markThreadDeleted } from "@bb/db";
import { installDefaultEnvironmentProviders } from "../helpers/environment-provider.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { startTestServer, type RunningTestServer } from "../helpers/test-app.js";

async function installPlugin(server: RunningTestServer, dir: string, name: string) {
  const rootDir = join(dir, `bb-plugin-${name}`);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${name}`,
      version: "0.1.0",
      bb: { name: name, description: "VK thread keys fixture.", branding: { icon: "Zap" }, server: "./server.ts" },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), "export default function plugin(_bb: any) {}\n");
  const entry = await server.pluginService.installPath(rootDir);
  expect(entry.status).toBe("running");
}

async function withKeyedPlugins(
  run: (args: { server: RunningTestServer; spawnArgs: Record<string, unknown> }) => Promise<void>,
) {
  const server = await startTestServer();
  installDefaultEnvironmentProviders();
  const dir = await mkdtemp(join(tmpdir(), "bb-vk-thread-keys-"));
  try {
    await installPlugin(server, dir, "keyed-a");
    await installPlugin(server, dir, "keyed-b");
    const workspacePath = "/tmp/vk-thread-keys-project";
    const { host } = seedHostSession(server.deps, { id: "host-vk-thread-keys" });
    const { project } = seedProjectWithSource(server.deps, { hostId: host.id, path: workspacePath });
    server.pluginService.bindSdk({ baseUrl: server.baseUrl });
    await run({
      server,
      spawnArgs: {
        environment: { type: "host", hostId: host.id, workspace: { type: "unmanaged", path: workspacePath } },
        projectId: project.id,
        prompt: "work",
        providerId: "codex",
      },
    });
  } finally {
    await server.pluginService.stop();
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
}

function apiOf(server: RunningTestServer, id: string) {
  const api = server.pluginService.getApi(id);
  if (!api) throw new Error(`${id} is not running`);
  return api.sdk.threads as any;
}

describe("VK thread keys on bb.sdk.threads", () => {
  it("two concurrent keyed spawns with one key make one thread", async () => {
    await withKeyedPlugins(async ({ server, spawnArgs }) => {
      const threads = apiOf(server, "keyed-a");
      const results = await Promise.all([
        threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "lp:att1:writer:1" }),
        threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "lp:att1:writer:1" }),
        threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "lp:att1:writer:1" }),
      ]);
      expect(new Set(results.map((result: any) => result.thread.id)).size).toBe(1);
      expect(results.filter((result: any) => !result.reused)).toHaveLength(1);
      const again = await threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "lp:att1:writer:1" });
      expect(again.reused).toBe(true);
      expect(again.thread.id).toBe(results[0].thread.id);
      const found = await threads.experimental_vkFindByKey("lp:att1:writer:1");
      expect(found?.id).toBe(results[0].thread.id);
      expect(await threads.experimental_vkFindByKey("lp:att1:writer:2")).toBeNull();
    });
  });

  it("attributes the thread to the plugin and keeps the caller's own metadata", async () => {
    await withKeyedPlugins(async ({ server, spawnArgs }) => {
      const threads = apiOf(server, "keyed-a");
      const { thread } = await threads.experimental_vkSpawnKeyed({
        ...spawnArgs,
        key: "k1",
        pluginMetadata: { role: "writer", attempt: "att1" },
      });
      expect(thread.originPluginId).toBe("keyed-a");
      const stored = await threads.getPluginMetadata({ threadId: thread.id });
      expect(stored).toEqual({ role: "writer", attempt: "att1", "__vk.key": "k1" });
      const byMeta = await threads.experimental_vkFindByPluginMetadata({ match: { attempt: "att1" } });
      expect(byMeta.map((entry: any) => entry.id)).toEqual([thread.id]);
      const none = await threads.experimental_vkFindByPluginMetadata({ match: { attempt: "att1" }, projectId: "other-project" });
      expect(none).toEqual([]);
    });
  });

  it("another plugin neither finds the key nor shares it", async () => {
    await withKeyedPlugins(async ({ server, spawnArgs }) => {
      const a = apiOf(server, "keyed-a");
      const b = apiOf(server, "keyed-b");
      const first = await a.experimental_vkSpawnKeyed({ ...spawnArgs, key: "shared", pluginMetadata: { x: 1 } });
      expect(await b.experimental_vkFindByKey("shared")).toBeNull();
      expect(await b.experimental_vkFindByPluginMetadata({ match: { x: 1 } })).toEqual([]);
      const second = await b.experimental_vkSpawnKeyed({ ...spawnArgs, key: "shared" });
      expect(second.reused).toBe(false);
      expect(second.thread.id).not.toBe(first.thread.id);
    });
  });

  it("does not return a deleted thread and lets its key be spawned again", async () => {
    await withKeyedPlugins(async ({ server, spawnArgs }) => {
      const threads = apiOf(server, "keyed-a");
      const first = await threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "gone" });
      markThreadDeleted(server.db, server.hub, { threadId: first.thread.id });
      expect(await threads.experimental_vkFindByKey("gone")).toBeNull();
      const second = await threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "gone" });
      expect(second.reused).toBe(false);
      expect(second.thread.id).not.toBe(first.thread.id);
    });
  });

  it("rejects bad keys and an empty match before touching anything", async () => {
    await withKeyedPlugins(async ({ server, spawnArgs }) => {
      const threads = apiOf(server, "keyed-a");
      await expect(threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "" })).rejects.toThrow("1 to 200");
      await expect(threads.experimental_vkSpawnKeyed({ ...spawnArgs, key: "x".repeat(201) })).rejects.toThrow("1 to 200");
      await expect(threads.experimental_vkFindByPluginMetadata({ match: {} })).rejects.toThrow("non-empty");
    });
  });

  it("stock threads.spawn is unchanged: no key, no dedupe, no reserved field", async () => {
    await withKeyedPlugins(async ({ server, spawnArgs }) => {
      const threads = apiOf(server, "keyed-a");
      const one = await threads.spawn({ ...spawnArgs, pluginMetadata: { role: "writer" } });
      const two = await threads.spawn({ ...spawnArgs, pluginMetadata: { role: "writer" } });
      expect(one.id).not.toBe(two.id);
      expect(await threads.getPluginMetadata({ threadId: one.id })).toEqual({ role: "writer" });
    });
  });
});
