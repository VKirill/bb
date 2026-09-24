import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createConnection, migrate } from "../../src/index.js";
import {
  threadPluginMetadata,
  threadVkCompiledMainRequired,
  threads,
} from "../../src/schema.js";
import { withWriteAfterFirstRead } from "../helpers/interleave.js";
import { createProject } from "../../src/data/projects.js";
import {
  createThread,
  deleteThread,
  searchThreadsWithPendingInteractionState,
} from "../../src/data/threads.js";
import {
  getThreadPluginMetadata,
  insertThreadPluginMetadata,
  insertVkCompiledMainAgentSnapshot,
  listThreadPluginMetadataRows,
  patchThreadPluginMetadata,
  readVkCompiledMainAgentSnapshot,
} from "../../src/data/thread-plugin-metadata.js";
import { VK_COMPILED_MAIN_AGENT_METADATA_KEY } from "@bb/domain/vk-compiled-main-agent";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup(name: string) {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: `${name}-host`,
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: `${name}-project`,
    source: { type: "local_path", hostId: host.id, path: `/tmp/${name}` },
  });
  return { db, project };
}

describe("thread plugin metadata persistence", () => {
  it("seeds one namespace and returns {} when absent", () => {
    const { db, project } = setup("seed");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "alpha", metadata: { a: 1, nullable: null } },
    });
    expect(getThreadPluginMetadata(db, thread.id, "alpha")).toEqual({
      metadata: { a: 1, nullable: null },
      corrupt: false,
    });
    expect(getThreadPluginMetadata(db, thread.id, "missing")).toEqual({
      metadata: {},
      corrupt: false,
    });
    insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "beta",
      metadata: { b: 2 },
    });
    expect(
      listThreadPluginMetadataRows(db, thread.id, ["alpha", "beta", "gamma"]),
    ).toEqual(
      expect.arrayContaining([
        { pluginId: "alpha", metadataJson: '{"a":1,"nullable":null}' },
        { pluginId: "beta", metadataJson: '{"b":2}' },
      ]),
    );
    expect(listThreadPluginMetadataRows(db, thread.id, ["beta"])).toEqual([
      { pluginId: "beta", metadataJson: '{"b":2}' },
    ]);
    expect(listThreadPluginMetadataRows(db, thread.id, [])).toEqual([]);
  });

  it("stores no row for an empty seed", () => {
    const { db, project } = setup("empty-seed");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "alpha", metadata: {} },
    });
    expect(listThreadPluginMetadataRows(db, thread.id, ["alpha"])).toEqual([]);
  });

  it("shallow sets then removes atomically, including null and empty deletion", () => {
    const { db, project } = setup("patch");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "p",
      metadata: { nested: { old: true }, keep: 1 },
    });
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: { nested: { next: true }, nullable: null },
        remove: ["keep"],
      }),
    ).toEqual({
      ok: true,
      metadata: { nested: { next: true }, nullable: null },
      replacedCorrupt: false,
    });
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: {},
        remove: ["missing"],
      }),
    ).toEqual({
      ok: true,
      metadata: { nested: { next: true }, nullable: null },
      replacedCorrupt: false,
    });
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: {},
        remove: ["nested", "nullable"],
      }),
    ).toEqual({ ok: true, metadata: {}, replacedCorrupt: false });
    expect(listThreadPluginMetadataRows(db, thread.id, ["p"])).toEqual([]);
  });

  it("reports an oversized merge without changing the stored namespace", () => {
    const { db, project } = setup("oversized");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "p",
      metadata: { preserved: "x".repeat(200 * 1024) },
    });
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: { extra: "y".repeat(100 * 1024) },
        remove: [],
      }),
    ).toEqual({ ok: false, reason: "too_large" });
    expect(getThreadPluginMetadata(db, thread.id, "p")).toEqual({
      metadata: { preserved: "x".repeat(200 * 1024) },
      corrupt: false,
    });
  });

  it("reports a corrupt row as {} and lets a patch replace it", () => {
    const { db, project } = setup("corrupt");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    for (const metadataJson of ["not-json", "[1,2]", "null"]) {
      db.delete(threadPluginMetadata).run();
      db.insert(threadPluginMetadata)
        .values({ threadId: thread.id, pluginId: "p", metadataJson })
        .run();
      expect(getThreadPluginMetadata(db, thread.id, "p")).toEqual({
        metadata: {},
        corrupt: true,
      });
      expect(
        patchThreadPluginMetadata(db, {
          threadId: thread.id,
          pluginId: "p",
          set: { repaired: true },
          remove: [],
        }),
      ).toEqual({
        ok: true,
        metadata: { repaired: true },
        replacedCorrupt: true,
      });
      expect(getThreadPluginMetadata(db, thread.id, "p")).toEqual({
        metadata: { repaired: true },
        corrupt: false,
      });
    }
  });

  it("rejects a competing file-backed write after the first read while immediate holds the lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-thread-plugin-metadata-"));
    const path = join(directory, "db.sqlite");
    const first = createConnection(path);
    const second = createConnection(path);
    try {
      migrate(first);
      const threadId = "thread-concurrency";
      first.$client.pragma("foreign_keys = OFF");
      first
        .insert(threadPluginMetadata)
        .values({
          threadId,
          pluginId: "p",
          metadataJson: JSON.stringify({ initial: true }),
        })
        .run();
      second.$client.pragma("busy_timeout = 0");
      let secondWrites = 0;
      const secondPatch = () => {
        secondWrites += 1;
        expect(() =>
          patchThreadPluginMetadata(second, {
            threadId,
            pluginId: "p",
            set: { competing: true },
            remove: [],
          }),
        ).toThrow(/locked|busy/u);
      };
      const transactionProxy = new Proxy(first, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "transaction" || typeof value !== "function") {
            return value;
          }
          return (callback: (tx: unknown) => unknown, options?: unknown) =>
            Reflect.apply(value, target, [
              (tx: unknown) =>
                callback(withWriteAfterFirstRead(tx as object, secondPatch)),
              options,
            ]);
        },
      });
      expect(
        patchThreadPluginMetadata(transactionProxy, {
          threadId,
          pluginId: "p",
          set: { first: true },
          remove: [],
        }),
      ).toEqual({
        ok: true,
        metadata: { initial: true, first: true },
        replacedCorrupt: false,
      });
      expect(secondWrites).toBe(1);
      expect(getThreadPluginMetadata(first, threadId, "p")).toEqual({
        metadata: { initial: true, first: true },
        corrupt: false,
      });
    } finally {
      first.$client.close();
      second.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back thread and search state when initial metadata insertion fails", () => {
    const { db, project } = setup("rollback");
    db.$client.exec(`
      CREATE TRIGGER thread_plugin_metadata_before_insert_abort
      BEFORE INSERT ON thread_plugin_metadata
      BEGIN
        SELECT RAISE(ABORT, 'thread plugin metadata insert aborted');
      END;
    `);

    expect(() =>
      createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        title: "rollback-metadata-title",
        pluginMetadata: { pluginId: "alpha", metadata: { seeded: true } },
      }),
    ).toThrow(/thread plugin metadata insert aborted/u);
    expect(
      db.$client
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM threads WHERE title = 'rollback-metadata-title'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      db.$client
        .prepare<[], { count: number }>(
          "SELECT COUNT(*) AS count FROM thread_search_segments WHERE text = 'rollback-metadata-title'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps metadata out of thread search while retaining title discovery", () => {
    const { db, project } = setup("search");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "discoverable-metadata-title",
      pluginMetadata: {
        pluginId: "alpha",
        metadata: { marker: "metadata-only-search-marker" },
      },
    });
    expect(
      searchThreadsWithPendingInteractionState(db, {
        query: "discoverable-metadata-title",
        limitPerGroup: 20,
      }).active.results.map((result) => result.thread.id),
    ).toEqual([thread.id]);
    const privateResults = searchThreadsWithPendingInteractionState(db, {
      query: "metadata-only-search-marker",
      limitPerGroup: 20,
    });
    expect(privateResults.active.total).toBe(0);
    expect(privateResults.archived.total).toBe(0);
  });

  it("rejects reserved compiled-main-agent keys on ordinary insert and patch", () => {
    const { db, project } = setup("reserved-compiled");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "p", metadata: { role: "pm" } },
    });
    expect(() =>
      insertThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "q",
        metadata: { [VK_COMPILED_MAIN_AGENT_METADATA_KEY]: { id: "x" } },
      }),
    ).toThrow(/vk_compiled_main_agent_reserved_key/);
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "p",
        set: { [VK_COMPILED_MAIN_AGENT_METADATA_KEY]: { id: "injected" } },
        remove: [],
      }),
    ).toEqual({ ok: false, reason: "reserved_key" });
    expect(getThreadPluginMetadata(db, thread.id, "p")).toEqual({
      metadata: { role: "pm" },
      corrupt: false,
    });
    expect(readVkCompiledMainAgentSnapshot(db, thread.id)).toEqual({
      required: false,
      profile: null,
    });
  });

  it("rejects sourceHash mismatches without committing either required row", () => {
    const { db, project } = setup("compiled-source-hash");
    expect(() => createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
      vkCompiledMainAgent: {
        id: "copy-lead",
        sourceVersion: "lp-owned-1",
        sourceHash: "0".repeat(64),
        description: "Lane Pilot copy lead",
        prompt: "You are the Lane Pilot copy lead.",
      },
    })).toThrow("vk_compiled_main_agent_source_hash_mismatch");
    expect(db.select().from(threads).all()).toHaveLength(0);
    expect(db.select().from(threadVkCompiledMainRequired).all()).toHaveLength(0);
  });

  it("persists a required compiled snapshot that patch cannot overwrite or remove", () => {
    const { db, project } = setup("compiled-snapshot");
    const profile = {
      id: "copy-lead",
      sourceVersion: "lp-owned-1",
      sourceHash: "1e094bd44751835710629a6ea275c41e37d97f5242131c5d80f4b8646c5fe928",
      description: "Lane Pilot copy lead",
      prompt: "You are the Lane Pilot copy lead.",
    };
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "pm" } },
      vkCompiledMainAgent: profile,
    });
    expect(readVkCompiledMainAgentSnapshot(db, thread.id)).toEqual({
      required: true,
      profile,
    });
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "__vk.compiled-main-agent",
        set: { snapshot: { ...profile, prompt: "mutated" } },
        remove: [],
      }),
    ).toEqual({ ok: false, reason: "reserved_key" });
    expect(readVkCompiledMainAgentSnapshot(db, thread.id)).toEqual({
      required: true,
      profile,
    });
  });

  it("drops a mutated snapshot that keeps the same sourceHash", () => {
    const { db, project } = setup("compiled-mutated-prompt");
    const profile = {
      id: "copy-lead",
      sourceVersion: "lp-owned-1",
      sourceHash: "1e094bd44751835710629a6ea275c41e37d97f5242131c5d80f4b8646c5fe928",
      description: "Lane Pilot copy lead",
      prompt: "You are the Lane Pilot copy lead.",
    };
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
      vkCompiledMainAgent: profile,
    });
    expect(readVkCompiledMainAgentSnapshot(db, thread.id)).toEqual({
      required: true,
      profile,
    });
    db.update(threadPluginMetadata)
      .set({
        metadataJson: JSON.stringify({
          required: true,
          snapshot: { ...profile, prompt: "mutated without changing sourceHash" },
        }),
      })
      .where(
        and(
          eq(threadPluginMetadata.threadId, thread.id),
          eq(threadPluginMetadata.pluginId, "__vk.compiled-main-agent"),
        ),
      )
      .run();
    expect(() => readVkCompiledMainAgentSnapshot(db, thread.id)).toThrow(
      /vk_compiled_main_agent_dropped/,
    );
  });

  it("does not treat a deleted snapshot row as legacy when the required bit remains", () => {
    const { db, project } = setup("compiled-lost-snapshot");
    const profile = {
      id: "dev-orchestrator",
      sourceVersion: "lp-owned-1",
      sourceHash: "7d8bead37b9d035dc10d07077d457fe4dca64d155aa2549766a540fde1a99fdb",
      description: "Lane Pilot development orchestrator",
      prompt: "You are the Lane Pilot development orchestrator.",
    };
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
      vkCompiledMainAgent: profile,
    });
    expect(readVkCompiledMainAgentSnapshot(db, thread.id)).toEqual({
      required: true,
      profile,
    });
    db.delete(threadPluginMetadata)
      .where(
        and(
          eq(threadPluginMetadata.threadId, thread.id),
          eq(threadPluginMetadata.pluginId, "__vk.compiled-main-agent"),
        ),
      )
      .run();
    expect(() => readVkCompiledMainAgentSnapshot(db, thread.id)).toThrow(
      /vk_compiled_main_agent_dropped/,
    );
  });

  it("fail-closes a corrupt required compiled snapshot", () => {
    const { db, project } = setup("compiled-corrupt");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "claude-code",
    });
    insertVkCompiledMainAgentSnapshot(db, {
      threadId: thread.id,
      profile: {
        id: "seo-specialist",
        sourceVersion: "lp-owned-1",
        sourceHash: "7c6305fd7720f9391c3202e9a4721c214bea1b3d6ea361260c1d54842148f807",
        description: "Lane Pilot SEO specialist",
        prompt: "You are the Lane Pilot SEO specialist.",
      },
    });
    db.update(threadPluginMetadata)
      .set({ metadataJson: "not-json" })
      .where(eq(threadPluginMetadata.threadId, thread.id))
      .run();
    expect(getThreadPluginMetadata(db, thread.id, "__vk.compiled-main-agent")).toEqual({
      metadata: {},
      corrupt: true,
    });
    expect(
      patchThreadPluginMetadata(db, {
        threadId: thread.id,
        pluginId: "__vk.compiled-main-agent",
        set: { repaired: true },
        remove: [],
      }),
    ).toEqual({ ok: false, reason: "corrupt_reserved" });
    expect(() => readVkCompiledMainAgentSnapshot(db, thread.id)).toThrow(
      /vk_compiled_main_agent_dropped/,
    );
  });

  it("cascades metadata when its thread is deleted", () => {
    const { db, project } = setup("cascade");
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      pluginMetadata: { pluginId: "p", metadata: { seeded: true } },
    });
    expect(listThreadPluginMetadataRows(db, thread.id, ["p"])).toHaveLength(1);
    expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(listThreadPluginMetadataRows(db, thread.id, ["p"])).toEqual([]);
  });
});
