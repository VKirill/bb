import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { vkPolicyAllows, type VkSessionPolicy } from "@bb/domain/vk-session-policy";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { readVkRequiredSessionPolicy, narrowVkRequiredSessionPolicy } from "../../src/data/thread-required-session-policy.js";
import { patchThreadPluginMetadata, insertThreadPluginMetadata } from "../../src/data/thread-plugin-metadata.js";
import { digestVkCompiledMainAgentSource, readVkCompiledMainAgentSnapshot } from "../../src/data/thread-plugin-metadata.js";
import { threads, threadPluginMetadata, threadVkSessionPolicyRequired } from "../../src/schema.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "policy", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "policy", source: { type: "local_path", hostId: host.id, path: "/tmp/required-policy" } });
  const spawn = (policy?: VkSessionPolicy, parents: { parentThreadId?: string; sourceThreadId?: string; lifecycleOwnerThreadId?: string } = {}, providerId = "claude-code", vkCompiledMainAgent?: Parameters<typeof createThread>[2]["vkCompiledMainAgent"]) => createThread(db, noopNotifier, {
    projectId: project.id, providerId, ...parents,
    ...(policy ? { vkRequiredSessionPolicy: { version: 1, policy } } : {}),
    ...(vkCompiledMainAgent ? { vkCompiledMainAgent } : {}),
  });
  return { db, spawn };
}

describe("required policy persistence", () => {
  it("keeps ordinary legacy threads and denies unsupported creation atomically", () => {
    const { db, spawn } = setup();
    try {
      const legacy = spawn();
      expect(readVkRequiredSessionPolicy(db, legacy.id)).toBeNull();
      expect(() => spawn({ skills: { mode: "allow", names: [] } }, {}, "acp-cursor")).toThrow("unsupported");
      expect(db.select().from(threads).all()).toHaveLength(1);
      expect(db.select().from(threadVkSessionPolicyRequired).all()).toHaveLength(0);
    } finally { db.$client.close(); }
  });

  it.each(["parentThreadId", "sourceThreadId", "lifecycleOwnerThreadId"] as const)("retains %s ceiling through omitted requests and attempted widening", (link) => {
    const { db, spawn } = setup();
    try {
      const parent = spawn({ skills: { mode: "allow", names: ["safe*", "other"] }, projectInstructions: false });
      const child = spawn(undefined, { [link]: parent.id });
      const widened = spawn({ skills: { mode: "allow", names: ["*"] }, projectInstructions: true }, { parentThreadId: child.id });
      const policy = readVkRequiredSessionPolicy(db, widened.id)!.policy;
      expect(policy.projectInstructions).toBe(false);
      expect(vkPolicyAllows(policy.skills, "safe-public")).toBe(true);
      expect(vkPolicyAllows(policy.skills, "safe-secret")).toBe(true);
      expect(vkPolicyAllows(policy.skills, "outside")).toBe(false);
      const empty = spawn({ skills: { mode: "allow", names: [] } }, { parentThreadId: widened.id });
      expect(vkPolicyAllows(readVkRequiredSessionPolicy(db, empty.id)!.policy.skills, "safe-public")).toBe(false);
    } finally { db.$client.close(); }
  });

  it("retains system narrowing across retries and child creation", () => {
    const { db, spawn } = setup();
    try {
      const parent = spawn({});
      narrowVkRequiredSessionPolicy(db, parent.id, { bbPlugins: { mode: "allow", names: ["project-folders"] } });
      narrowVkRequiredSessionPolicy(db, parent.id, {});
      const child = spawn({}, { parentThreadId: parent.id });
      expect(vkPolicyAllows(readVkRequiredSessionPolicy(db, child.id)!.policy.bbPlugins, "unrelated")).toBe(false);
    } finally { db.$client.close(); }
  });

  it("re-hashes compiled resources after intersecting the durable parent ceiling", () => {
    const { db, spawn } = setup();
    try {
      const parent = spawn({
        skills: { mode: "allow", names: ["safe-skill"] },
        mcpServers: { mode: "allow", names: ["safe-server"] },
      });
      const sourceBody = {
        id: "copy-lead",
        sourceVersion: "lp-owned-2",
        description: "Copy lead",
        prompt: "Write clearly.",
        skills: ["safe-skill", "outside-skill"],
        mcpServers: ["safe-server", "outside-server"],
      };
      const inputHash = digestVkCompiledMainAgentSource(sourceBody);
      const child = spawn(undefined, { parentThreadId: parent.id }, "claude-code", {
        ...sourceBody,
        sourceHash: inputHash,
      });
      const stored = readVkCompiledMainAgentSnapshot(db, child.id);
      expect(stored.required).toBe(true);
      if (!stored.required) throw new Error("expected compiled profile");
      expect(stored.profile.skills).toEqual(["safe-skill"]);
      expect(stored.profile.mcpServers).toEqual(["safe-server"]);
      const { sourceHash, ...storedBody } = stored.profile;
      expect(sourceHash).not.toBe(inputHash);
      expect(sourceHash).toBe(digestVkCompiledMainAgentSource(storedBody));
    } finally { db.$client.close(); }
  });

  it.each(["marker", "snapshot", "digest", "json", "version"])("rejects corrupt %s and descendants", (failure) => {
    const { db, spawn } = setup();
    try {
      const thread = spawn({ userInstructions: false });
      const row = and(eq(threadPluginMetadata.threadId, thread.id), eq(threadPluginMetadata.pluginId, "__vk.required-session-policy"));
      if (failure === "marker") db.delete(threadVkSessionPolicyRequired).where(eq(threadVkSessionPolicyRequired.threadId, thread.id)).run();
      if (failure === "snapshot") db.delete(threadPluginMetadata).where(row).run();
      if (failure === "digest") db.update(threadPluginMetadata).set({ metadataJson: JSON.stringify({ version: 1, policy: {} }) }).where(row).run();
      if (failure === "json") db.update(threadPluginMetadata).set({ metadataJson: "{" }).where(row).run();
      if (failure === "version") db.update(threadPluginMetadata).set({ metadataJson: JSON.stringify({ version: 2, policy: {} }) }).where(row).run();
      expect(() => readVkRequiredSessionPolicy(db, thread.id)).toThrow();
      expect(() => spawn({}, { parentThreadId: thread.id })).toThrow();
      expect(db.select({ count: sql<number>`count(*)` }).from(threads).get()!.count).toBe(1);
    } finally { db.$client.close(); }
  });

  it("blocks reserved metadata writes and removals even on legacy rows", () => {
    const { db, spawn } = setup();
    try {
      const thread = spawn();
      for (const pluginId of ["regular", "__vk.required-session-policy"]) {
        expect(() => insertThreadPluginMetadata(db, { threadId: thread.id, pluginId, metadata: { experimental_vkRequiredSessionPolicy: {} } })).toThrow();
        expect(patchThreadPluginMetadata(db, { threadId: thread.id, pluginId, set: {}, remove: ["experimental_vkRequiredSessionPolicy"] }).ok).toBe(false);
      }
    } finally { db.$client.close(); }
  });

  it("digests the normalized snapshot independently of JSON property order", () => {
    const { db, spawn } = setup();
    try {
      const thread = spawn({
        skills: { mode: "allow", names: ["safe"] },
        projectInstructions: false,
      });
      const snapshot = readVkRequiredSessionPolicy(db, thread.id)!;
      const reordered = {
        policy: {
          projectInstructions: false,
          skills: { names: ["safe"], mode: "allow", allOf: [] },
        },
        version: 1,
      };
      db.update(threadPluginMetadata)
        .set({ metadataJson: JSON.stringify(reordered) })
        .where(
          and(
            eq(threadPluginMetadata.threadId, thread.id),
            eq(threadPluginMetadata.pluginId, "__vk.required-session-policy"),
          ),
        )
        .run();
      expect(readVkRequiredSessionPolicy(db, thread.id)).toEqual(snapshot);
    } finally {
      db.$client.close();
    }
  });
});
