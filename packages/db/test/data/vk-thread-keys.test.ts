import { describe, expect, it } from "vitest";
import { createProject } from "../../src/data/projects.js";
import { archiveThread, createThread, markThreadDeleted } from "../../src/data/threads.js";
import { getThreadPluginMetadata, patchThreadPluginMetadata } from "../../src/data/thread-plugin-metadata.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  VK_THREAD_KEY_METADATA_KEY,
  VkThreadKeyConflictError,
  findVkThreadIdByKey,
  findVkThreadIdsByPluginMetadata,
  isValidVkThreadKey,
} from "../../src/data/vk-thread-keys.js";
import { noopNotifier } from "../../src/notifier.js";
import { threads } from "../../src/schema.js";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "keys-host", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "keys", source: { type: "local_path", hostId: host.id, path: "/tmp/keys" } });
  const { project: other } = createProject(db, noopNotifier, { name: "keys-2", source: { type: "local_path", hostId: host.id, path: "/tmp/keys2" } });
  return { db, project, other };
}

describe("VK thread keys", () => {
  it("stores the key beside the plugin's own metadata and finds the thread by it", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "writer" } },
      vkKey: { pluginId: "lane-pilot", key: "lp:att1:writer:1" },
    });
    expect(getThreadPluginMetadata(db, thread.id, "lane-pilot").metadata).toEqual({
      role: "writer",
      [VK_THREAD_KEY_METADATA_KEY]: "lp:att1:writer:1",
    });
    expect(findVkThreadIdByKey(db, "lane-pilot", "lp:att1:writer:1")).toBe(thread.id);
    expect(findVkThreadIdByKey(db, "lane-pilot", "lp:att1:writer:2")).toBeNull();
  });

  it("refuses a second live thread with the same key and keeps the first", () => {
    const { db, project } = setup();
    const first = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", vkKey: { pluginId: "lane-pilot", key: "k" } });
    let conflict: unknown;
    try {
      createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", vkKey: { pluginId: "lane-pilot", key: "k" } });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(VkThreadKeyConflictError);
    expect((conflict as VkThreadKeyConflictError).threadId).toBe(first.id);
    // The failed create rolled back whole: no half-created thread.
    expect(findVkThreadIdsByPluginMetadata(db, { pluginId: "lane-pilot", match: { [VK_THREAD_KEY_METADATA_KEY]: "k" } })).toEqual([first.id]);
  });

  it("scopes the key to the plugin: another plugin neither sees nor collides with it", () => {
    const { db, project } = setup();
    const mine = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", vkKey: { pluginId: "lane-pilot", key: "shared" } });
    const theirs = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", vkKey: { pluginId: "other-plugin", key: "shared" } });
    expect(findVkThreadIdByKey(db, "lane-pilot", "shared")).toBe(mine.id);
    expect(findVkThreadIdByKey(db, "other-plugin", "shared")).toBe(theirs.id);
    expect(findVkThreadIdByKey(db, "third", "shared")).toBeNull();
  });

  it("does not return a deleted thread and lets its key be used again; an archived thread still holds it", () => {
    const { db, project } = setup();
    const first = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", vkKey: { pluginId: "lane-pilot", key: "again" } });
    archiveThread(db, noopNotifier, first.id);
    expect(findVkThreadIdByKey(db, "lane-pilot", "again")).toBe(first.id);
    markThreadDeleted(db, noopNotifier, { threadId: first.id });
    expect(findVkThreadIdByKey(db, "lane-pilot", "again")).toBeNull();
    const second = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", vkKey: { pluginId: "lane-pilot", key: "again" } });
    expect(findVkThreadIdByKey(db, "lane-pilot", "again")).toBe(second.id);
  });

  it("a thread without a key stores exactly the caller's metadata, as in stock", () => {
    const { db, project } = setup();
    const plain = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "critic" } } });
    const empty = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", pluginMetadata: { pluginId: "lane-pilot", metadata: {} } });
    expect(getThreadPluginMetadata(db, plain.id, "lane-pilot").metadata).toEqual({ role: "critic" });
    expect(getThreadPluginMetadata(db, empty.id, "lane-pilot").metadata).toEqual({});
  });

  it("finds by own metadata with project and archive filters, newest first, and respects the limit", () => {
    const { db, project, other } = setup();
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      ids.push(createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", pluginMetadata: { pluginId: "lane-pilot", metadata: { attempt: "a1", n: index, live: index % 2 === 0 } } }).id);
    }
    // Distinct creation times: threads made in the same millisecond tie on createdAt and fall back to id order.
    ids.forEach((id, index) => db.update(threads).set({ createdAt: 1_000 + index }).where(eq(threads.id, id)).run());
    const foreign = createThread(db, noopNotifier, { projectId: other.id, providerId: "codex", pluginMetadata: { pluginId: "lane-pilot", metadata: { attempt: "a1", n: 9, live: true } } });
    const notMine = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", pluginMetadata: { pluginId: "someone", metadata: { attempt: "a1" } } });
    archiveThread(db, noopNotifier, ids[1]!);
    const found = (extra: Record<string, unknown> = {}) =>
      findVkThreadIdsByPluginMetadata(db, { pluginId: "lane-pilot", match: { attempt: "a1" }, ...extra });
    expect(found({ projectId: project.id }).sort()).toEqual([ids[0], ids[2], ids[3]].sort());
    expect(found({ projectId: project.id, includeArchived: true }).sort()).toEqual([...ids].sort());
    expect(found()).toContain(foreign.id);
    expect(found()).not.toContain(notMine.id);
    expect(found({ limit: 2 })).toHaveLength(2);
    expect(findVkThreadIdsByPluginMetadata(db, { pluginId: "lane-pilot", match: { attempt: "a1", live: true }, projectId: project.id })).toEqual([ids[2], ids[0]]);
    expect(findVkThreadIdsByPluginMetadata(db, { pluginId: "lane-pilot", match: { n: 3 } })).toEqual([ids[3]]);
  });

  it("rejects an empty match and unsafe field names", () => {
    const { db } = setup();
    expect(() => findVkThreadIdsByPluginMetadata(db, { pluginId: "lane-pilot", match: {} })).toThrow("vk_find_by_metadata_empty_match");
    expect(() => findVkThreadIdsByPluginMetadata(db, { pluginId: "lane-pilot", match: { 'a"b': 1 } })).toThrow("vk_find_by_metadata_bad_field");
  });

  it("validates key shape", () => {
    expect(isValidVkThreadKey("x")).toBe(true);
    expect(isValidVkThreadKey("x".repeat(200))).toBe(true);
    expect(isValidVkThreadKey("x".repeat(201))).toBe(false);
    expect(isValidVkThreadKey("")).toBe(false);
    expect(isValidVkThreadKey(5)).toBe(false);
  });

  it("a metadata patch may re-send the key unchanged but never change or drop it", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", pluginMetadata: { pluginId: "lane-pilot", metadata: { a: 1 } }, vkKey: { pluginId: "lane-pilot", key: "fixed" } });
    const patch = (set: Record<string, unknown>, remove: string[] = []) =>
      patchThreadPluginMetadata(db, { threadId: thread.id, pluginId: "lane-pilot", set: set as never, remove });
    expect(patch({ a: 2 }).ok).toBe(true);
    expect(patch({ [VK_THREAD_KEY_METADATA_KEY]: "fixed", a: 3 }).ok).toBe(true);
    expect(patch({ [VK_THREAD_KEY_METADATA_KEY]: "other" })).toEqual({ ok: false, reason: "reserved_key" });
    expect(patch({}, [VK_THREAD_KEY_METADATA_KEY])).toEqual({ ok: false, reason: "reserved_key" });
    expect(findVkThreadIdByKey(db, "lane-pilot", "fixed")).toBe(thread.id);
    // A thread that never had a key cannot claim one by patching: that would skip the uniqueness check.
    const bare = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    expect(patchThreadPluginMetadata(db, { threadId: bare.id, pluginId: "lane-pilot", set: { [VK_THREAD_KEY_METADATA_KEY]: "claim" }, remove: [] })).toEqual({ ok: false, reason: "reserved_key" });
    // Stock behaviour for everything else.
    expect(patchThreadPluginMetadata(db, { threadId: bare.id, pluginId: "lane-pilot", set: { x: 1 }, remove: [] }).ok).toBe(true);
  });
});
