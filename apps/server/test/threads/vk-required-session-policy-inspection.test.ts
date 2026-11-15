import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  archiveThread,
  insertVkRequiredSessionPolicy,
  markProjectDeleted,
  markThreadDeleted,
  readVkRequiredSessionPolicy,
  threadPluginMetadata,
  VK_REQUIRED_SESSION_POLICY_MARKER_ID,
} from "@bb/db";
import { VK_REQUIRED_SESSION_POLICY_PLUGIN_ID } from "@bb/domain/vk-session-policy";
import type {
  ExperimentalVkInspectRequiredSessionPoliciesArgs,
  PluginBbSdk,
} from "@get-bb/plugin-sdk";
import { installDefaultEnvironmentProviders } from "../helpers/environment-provider.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

async function installPlugin(
  server: RunningTestServer,
  dir: string,
  name: string,
) {
  const rootDir = join(dir, `bb-plugin-${name}`);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${name}`,
      version: "0.1.0",
      bb: {
        name,
        description: "VK policy inspection fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(rootDir, "server.ts"),
    "export default function plugin(_bb: any) {}\n",
  );
  const entry = await server.pluginService.installPath(rootDir);
  expect(entry.status).toBe("running");
}

async function withInspectionPlugin(
  run: (args: {
    server: RunningTestServer;
    projectId: string;
    threads: PluginBbSdk["threads"];
    call: (args: unknown) => Promise<any>;
    callOther: (args: unknown) => Promise<any>;
    inspect: (threadIds: string[]) => Promise<any>;
  }) => Promise<void>,
) {
  const server = await startTestServer();
  installDefaultEnvironmentProviders();
  const dir = await mkdtemp(join(tmpdir(), "bb-vk-policy-inspect-"));
  try {
    await installPlugin(server, dir, "inspector");
    await installPlugin(server, dir, "inspector-b");
    const { host } = seedHostSession(server.deps, {
      id: "host-vk-inspect",
    });
    const { project } = seedProjectWithSource(server.deps, {
      hostId: host.id,
      path: "/tmp/vk-policy-inspect-project",
    });
    server.pluginService.bindSdk({ baseUrl: server.baseUrl });
    const api = server.pluginService.getApi("inspector");
    if (!api) throw new Error("inspector is not running");
    const threads: PluginBbSdk["threads"] = api.sdk.threads;
    const method = threads.experimental_vkInspectRequiredSessionPolicies;
    expect(typeof method).toBe("function");
    const call = (args: unknown) =>
      method!.call(
        threads,
        args as ExperimentalVkInspectRequiredSessionPoliciesArgs,
      );
    const otherApi = server.pluginService.getApi("inspector-b");
    if (!otherApi) throw new Error("inspector-b is not running");
    const otherThreads: PluginBbSdk["threads"] = otherApi.sdk.threads;
    const otherMethod =
      otherThreads.experimental_vkInspectRequiredSessionPolicies;
    expect(typeof otherMethod).toBe("function");
    const callOther = (args: unknown) =>
      otherMethod!.call(
        otherThreads,
        args as ExperimentalVkInspectRequiredSessionPoliciesArgs,
      );
    await run({
      server,
      projectId: project.id,
      threads,
      call,
      callOther,
      inspect: (threadIds: string[]) => call({ threadIds }),
    });
  } finally {
    await server.pluginService.stop();
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
}

function storePolicy(server: RunningTestServer, threadId: string) {
  server.db.transaction((tx) => {
    insertVkRequiredSessionPolicy(tx, {
      threadId,
      providerId: "codex",
      requested: { version: 1, policy: { projectInstructions: false } },
      parentIds: [],
    });
  });
}

function policyRow(server: RunningTestServer, threadId: string) {
  return server.db
    .select()
    .from(threadPluginMetadata)
    .where(policyRowWhere(threadId))
    .get();
}

function policyRowWhere(threadId: string) {
  return and(
    eq(threadPluginMetadata.threadId, threadId),
    eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_PLUGIN_ID),
  );
}

function setPolicyJson(
  server: RunningTestServer,
  threadId: string,
  metadataJson: string,
) {
  server.db
    .update(threadPluginMetadata)
    .set({ metadataJson })
    .where(policyRowWhere(threadId))
    .run();
}

describe("experimental_vkInspectRequiredSessionPolicies", () => {
  it("reports valid, absent and unavailable in request order", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const withPolicy = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      const plain = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, withPolicy.id);
      const missingId = `${plain.id}-missing`;

      const result = await inspect([plain.id, withPolicy.id, missingId]);
      expect(result.version).toBe(1);
      expect(result.results).toHaveLength(3);
      expect(result.results.map((entry: any) => entry.threadId)).toEqual([
        plain.id,
        withPolicy.id,
        missingId,
      ]);
      expect(result.results[0]).toEqual({
        threadId: plain.id,
        status: "absent",
      });
      expect(result.results[1]).toMatchObject({
        threadId: withPolicy.id,
        status: "valid",
        snapshot: {
          version: 1,
          policy: { projectInstructions: false },
        },
      });
      // A legacy row written before the ceiling split carries no ceiling key at all.
      expect(result.results[1].snapshot).not.toHaveProperty("ceiling");
      expect(result.results[2]).toEqual({
        threadId: missingId,
        status: "unavailable",
      });
    });
  });

  it("reports a deleted thread as unavailable, not absent", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      markThreadDeleted(server.db, server.hub, { threadId: thread.id });
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        { threadId: thread.id, status: "unavailable" },
      ]);
    });
  });

  it("reports a metadata row without its marker as incomplete_snapshot", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      server.db
        .insert(threadPluginMetadata)
        .values({
          threadId: thread.id,
          pluginId: VK_REQUIRED_SESSION_POLICY_PLUGIN_ID,
          metadataJson: JSON.stringify({ version: 1, policy: {} }),
        })
        .run();
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "invalid",
          reason: "incomplete_snapshot",
        },
      ]);
    });
  });

  it("reports unparseable stored JSON as malformed_snapshot", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      setPolicyJson(server, thread.id, "{not-json");
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "invalid",
          reason: "malformed_snapshot",
        },
      ]);
    });
  });

  it("reports schema-invalid stored JSON as malformed_snapshot", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      setPolicyJson(
        server,
        thread.id,
        JSON.stringify({ version: 2, policy: "nope" }),
      );
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "invalid",
          reason: "malformed_snapshot",
        },
      ]);
    });
  });

  it("reports a valid snapshot under a stale digest as digest_mismatch", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      setPolicyJson(
        server,
        thread.id,
        JSON.stringify({
          version: 1,
          policy: { projectInstructions: true },
        }),
      );
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "invalid",
          reason: "digest_mismatch",
        },
      ]);
    });
  });

  it("rejects malformed input as a whole before any lookup", async () => {
    await withInspectionPlugin(async ({ server, projectId, call }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      const badArgs: unknown[] = [
        {},
        null,
        [],
        "not-an-object",
        { threadIds: [] },
        { threadIds: "nope" },
        { threadIds: [""] },
        { threadIds: [thread.id, thread.id] },
        { threadIds: Array.from({ length: 201 }, (_, i) => `t${i}`) },
        { threadIds: [thread.id], pluginId: "other" },
        { threadIds: [thread.id], namespace: "__vk" },
        { threadIds: [thread.id], policy: {} },
        { threadIds: [thread.id], set: true },
        { threadIds: [thread.id], caller: "x" },
      ];
      for (const args of badArgs) {
        await expect(call(args)).rejects.toThrow();
      }
    });
  });

  it("rejects a retained SDK reference after the plugin is disposed", async () => {
    const server = await startTestServer();
    installDefaultEnvironmentProviders();
    const dir = await mkdtemp(join(tmpdir(), "bb-vk-policy-inspect-"));
    try {
      await installPlugin(server, dir, "inspector");
      const { host } = seedHostSession(server.deps, {
        id: "host-vk-inspect-stale",
      });
      const { project } = seedProjectWithSource(server.deps, {
        hostId: host.id,
        path: "/tmp/vk-policy-inspect-stale",
      });
      server.pluginService.bindSdk({ baseUrl: server.baseUrl });
      const api = server.pluginService.getApi("inspector");
      if (!api) throw new Error("inspector is not running");
      const threads: PluginBbSdk["threads"] = api.sdk.threads;
      const method = threads.experimental_vkInspectRequiredSessionPolicies;
      const thread = seedThread(server.deps, {
        projectId: project.id,
        providerId: "codex",
      });
      await server.pluginService.stop();
      await expect(
        method!.call(threads, { threadIds: [thread.id] }),
      ).rejects.toThrow();
    } finally {
      await server.pluginService.stop();
      await rm(dir, { recursive: true, force: true });
      await server.close();
    }
  });

  it("still inspects an archived thread: archive is not deletion", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      archiveThread(server.db, server.hub, thread.id);
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "valid",
          snapshot: {
            version: 1,
            policy: { projectInstructions: false },
          },
        },
      ]);
    });
  });

  it("reports unavailable when the thread's project is deleted", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      markProjectDeleted(server.db, server.hub, { projectId });
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        { threadId: thread.id, status: "unavailable" },
      ]);
    });
  });

  it("reports a marker row without its snapshot row as incomplete_snapshot", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      server.db
        .insert(threadPluginMetadata)
        .values({
          threadId: thread.id,
          pluginId: VK_REQUIRED_SESSION_POLICY_MARKER_ID,
          metadataJson: JSON.stringify({ snapshotDigest: "deadbeef" }),
        })
        .run();
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "invalid",
          reason: "incomplete_snapshot",
        },
      ]);
    });
  });

  it("gives every plugin the same instance-wide view of a thread", async () => {
    await withInspectionPlugin(async ({ server, projectId, callOther, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      const mine = await inspect([thread.id]);
      const other = await callOther({ threadIds: [thread.id] });
      expect(other).toEqual(mine);
      expect(other.results[0].status).toBe("valid");
    });
  });

  it("rejects reserved-namespace and policy-shaped metadata; ordinary forge has no authority", async () => {
    await withInspectionPlugin(async ({ server, projectId, threads, inspect }) => {
      const bare = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      const stored = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, stored.id);
      const reserved = VK_REQUIRED_SESSION_POLICY_PLUGIN_ID;
      const before = policyRow(server, stored.id);
      expect(before).toBeDefined();

      // Reserved pluginId fails schema validation on every metadata surface (get/list/update),
      // and policy-shaped keys in the caller's OWN namespace fail the reserved-key patch rule —
      // all 400, no read/write/partial application, stored row byte-identical afterwards.
      for (const threadId of [bare.id, stored.id]) {
        for (const attempt of [
          () =>
            threads.getPluginMetadata({ threadId, pluginId: reserved }),
          () =>
            threads.experimental_listPluginMetadata({
              pluginId: reserved,
              threadIds: [threadId],
            }),
          () =>
            threads.updatePluginMetadata({
              threadId,
              pluginId: reserved,
              set: { forged: true },
            }),
          () =>
            threads.updatePluginMetadata({
              threadId,
              pluginId: reserved,
              remove: ["policy"],
            }),
          () =>
            threads.updatePluginMetadata({
              threadId,
              set: {
                experimental_vkRequiredSessionPolicy: {
                  version: 1,
                  policy: { projectInstructions: true },
                },
              },
            }),
          () =>
            threads.updatePluginMetadata({
              threadId,
              set: {
                experimental_vkCompiledMainAgent: { id: "forged" },
              },
            }),
          () =>
            threads.updatePluginMetadata({
              threadId,
              remove: ["experimental_vkRequiredSessionPolicy"],
            }),
        ]) {
          const error = await attempt().then(
            () => null,
            (caught: unknown) => caught,
          );
          expect(error).not.toBeNull();
          expect((error as { status?: number }).status).toBe(400);
        }
      }
      expect(policyRow(server, stored.id)).toEqual(before);
      expect(policyRow(server, bare.id)).toBeUndefined();

      // Ordinary own-namespace metadata IS writable — a plugin can store any benign keys —
      // and it still has no authority: inspection reports absent, never a forged policy.
      await threads.updatePluginMetadata({
        threadId: bare.id,
        set: { role: "writer", note: "not-a-policy" },
      });
      const result = await inspect([bare.id, stored.id]);
      expect(result.results).toEqual([
        { threadId: bare.id, status: "absent" },
        {
          threadId: stored.id,
          status: "valid",
          snapshot: {
            version: 1,
            policy: { projectInstructions: false },
          },
        },
      ]);
    });
  });

  it("reports valid snapshots for composite, ceiling-bearing and empty-allow policies", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const composite = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      const ceilinged = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      const emptyAllow = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      server.db.transaction((tx) => {
        insertVkRequiredSessionPolicy(tx, {
          threadId: composite.id,
          providerId: "codex",
          requested: {
            version: 1,
            policy: {
              bbPlugins: { mode: "allow", names: ["docs"] },
              skills: {
                mode: "deny",
                names: ["internal-*"],
                allOf: [{ mode: "allow", names: ["shared-*"] }],
              },
              projectInstructions: false,
            },
          },
          parentIds: [],
        });
        insertVkRequiredSessionPolicy(tx, {
          threadId: ceilinged.id,
          providerId: "codex",
          requested: {
            version: 1,
            policy: {
              projectInstructions: false,
              skills: { mode: "deny", names: ["a"] },
            },
          },
          agentPolicy: { mcpServers: { mode: "allow", names: ["x"] } },
          parentIds: [],
        });
        insertVkRequiredSessionPolicy(tx, {
          threadId: emptyAllow.id,
          providerId: "codex",
          requested: {
            version: 1,
            policy: { bbPlugins: { mode: "allow", names: [] } },
          },
          parentIds: [],
        });
      });

      const result = await inspect([
        composite.id,
        ceilinged.id,
        emptyAllow.id,
      ]);
      expect(result.results.map((entry: any) => entry.status)).toEqual([
        "valid",
        "valid",
        "valid",
      ]);
      // The DTO must be exactly the canonical stored snapshot — insertion normalizes filter
      // syntax (deny-outer/allow-allOf arrives as allow-outer/deny-allOf, same intersection),
      // so compare against what the reader returns, not the requested spelling.
      const [compositeResult, ceilingedResult, emptyResult] = result.results;
      for (const [entry, threadId] of [
        [compositeResult, composite.id],
        [ceilingedResult, ceilinged.id],
        [emptyResult, emptyAllow.id],
      ] as const) {
        const stored = readVkRequiredSessionPolicy(server.db, threadId);
        expect(stored).not.toBeNull();
        expect(entry.snapshot).toEqual({
          version: 1,
          policy: stored!.policy,
          ...(stored!.ceiling === undefined
            ? {}
            : { ceiling: stored!.ceiling }),
        });
      }
      // Explicit shape assertions independent of normalization spelling.
      expect(compositeResult.snapshot.policy.skills).toHaveProperty("allOf");
      expect(compositeResult.snapshot.policy).toMatchObject({
        projectInstructions: false,
      });
      expect(emptyResult.snapshot.policy.bbPlugins).toMatchObject({
        mode: "allow",
        names: [],
      });
      // agentPolicy narrows policy below the stored ceiling: they must differ.
      expect(ceilingedResult.snapshot.policy).toHaveProperty("mcpServers");
      expect(ceilingedResult.snapshot.ceiling).toBeDefined();
      expect(ceilingedResult.snapshot.ceiling).not.toHaveProperty("mcpServers");
      expect(ceilingedResult.snapshot.ceiling).not.toEqual(
        ceilingedResult.snapshot.policy,
      );
    });
  });

  it("reports an unparseable marker row as digest_mismatch", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      // A corrupt marker reads back as an empty marker: the snapshot parses but its digest
      // can never match — fail-closed digest_mismatch, not malformed and not absent.
      server.db
        .update(threadPluginMetadata)
        .set({ metadataJson: "{corrupt-marker" })
        .where(
          and(
            eq(threadPluginMetadata.threadId, thread.id),
            eq(
              threadPluginMetadata.pluginId,
              VK_REQUIRED_SESSION_POLICY_MARKER_ID,
            ),
          ),
        )
        .run();
      const result = await inspect([thread.id]);
      expect(result.results).toEqual([
        {
          threadId: thread.id,
          status: "invalid",
          reason: "digest_mismatch",
        },
      ]);
    });
  });

  it("rejects the whole call on an unexpected reader failure", async () => {
    await withInspectionPlugin(async ({ server, projectId, inspect }) => {
      const thread = seedThread(server.deps, {
        projectId,
        providerId: "codex",
      });
      storePolicy(server, thread.id);
      // Real DB, real failure: dropping the metadata table makes the policy read throw a
      // SqliteError that maps to no result status — the call must reject, not report partials.
      server.db.$client.exec("DROP TABLE thread_plugin_metadata");
      await expect(inspect([thread.id])).rejects.toThrow();
    });
  });
});
