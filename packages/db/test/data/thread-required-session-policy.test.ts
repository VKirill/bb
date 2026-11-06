import { VK_REQUIRED_SESSION_POLICY_MARKER_ID, VK_COMPILED_MAIN_AGENT_MARKER_ID } from "../../src/data/vk-thread-marker.js";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { vkPolicyAllows, type VkSessionPolicy } from "@bb/domain/vk-session-policy";
import { createMigratedConnection } from "../../src/testing.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { readVkRequiredSessionPolicy, narrowVkRequiredSessionPolicy, vkRequiredSessionPolicyDigest } from "../../src/data/thread-required-session-policy.js";
import { writeVkThreadMarker } from "../../src/data/vk-thread-marker.js";
import { patchThreadPluginMetadata, insertThreadPluginMetadata } from "../../src/data/thread-plugin-metadata.js";
import { digestVkCompiledMainAgentSource, readVkCompiledMainAgentSnapshot } from "../../src/data/thread-plugin-metadata.js";
import {
  threads,
  threadPluginMetadata,
} from "../../src/schema.js";

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
      // Cursor narrows BB skills since vk.15; native plugins it still cannot narrow.
      expect(() => spawn({ nativePlugins: { mode: "allow", names: [] } }, {}, "acp-cursor")).toThrow("unsupported");
      expect(db.select().from(threads).all()).toHaveLength(1);
      expect(db.select().from(threadPluginMetadata).where(eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_MARKER_ID)).all()).toHaveLength(0);
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

  it("creates an OpenCode v2 thread for the groups its bridge enforces, also through a parent ceiling", () => {
    const { db, spawn } = setup();
    try {
      const ok = spawn({ bbPlugins: { mode: "allow", names: ["env-catalog"] }, userInstructions: false, skills: { mode: "allow", names: [] }, mcpServers: { mode: "deny", names: ["x"] } }, {}, "opencode2");
      expect(readVkRequiredSessionPolicy(db, ok.id)!.policy.userInstructions).toBe(false);
      expect(() => spawn({ nativePlugins: { mode: "allow", names: [] } }, {}, "opencode2")).toThrow("unsupported_opencode2_nativePlugins");
      const parent = spawn({ nativePlugins: { mode: "deny", names: ["x"] } });
      expect(() => spawn(undefined, { parentThreadId: parent.id }, "opencode2")).toThrow("unsupported_opencode2_nativePlugins");
      expect(() => spawn({ projectInstructions: false }, {}, "opencode2")).toThrow("unsupported_opencode2_projectInstructions");
      expect(db.select().from(threads).all()).toHaveLength(2);
    } finally { db.$client.close(); }
  });

  it("lets a codex child inherit a Claude Code parent's ceiling that turns claude.ai sync off", () => {
    const { db, spawn } = setup();
    try {
      const parent = spawn({ claudeAiSync: false, skills: { mode: "allow", names: ["ru-text"] } });
      const child = spawn({ skills: { mode: "allow", names: ["ru-text", "other"] } }, { parentThreadId: parent.id }, "codex");
      const policy = readVkRequiredSessionPolicy(db, child.id)!.policy;
      expect(policy.claudeAiSync).toBeUndefined();
      expect(vkPolicyAllows(policy.skills, "ru-text")).toBe(true);
      expect(vkPolicyAllows(policy.skills, "other")).toBe(false);
      expect(readVkRequiredSessionPolicy(db, parent.id)!.policy.claudeAiSync).toBe(false);
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

  it.each(["codex", "claude-code"] as const)(
    "stays a required thread without inheriting a compiled MAIN role's working set on %s",
    (providerId) => {
      const { db, spawn } = setup();
      try {
        const sourceBody = {
          id: "copy-lead",
          sourceVersion: "lp-owned-1",
          description: "Copy lead",
          prompt: "Write clearly.",
          skills: ["safe-skill"],
        };
        const parent = spawn(undefined, {}, "claude-code", {
          ...sourceBody,
          sourceHash: digestVkCompiledMainAgentSource(sourceBody),
        });
        const child = spawn(undefined, { parentThreadId: parent.id }, providerId);

        expect(readVkCompiledMainAgentSnapshot(db, child.id)).toEqual({
          required: false,
          profile: null,
        });
        // The parent's agent skills are its own working set, not the child's ceiling.
        const snapshot = readVkRequiredSessionPolicy(db, child.id);
        expect(snapshot?.policy.skills).toBeUndefined();
        expect(snapshot?.ceiling).toBeUndefined();
      } finally {
        db.$client.close();
      }
    },
  );

  it("keeps a child's explicit skill request whole under a compiled MAIN parent", () => {
    const { db, spawn } = setup();
    try {
      const sourceBody = {
        id: "pm",
        sourceVersion: "lp-owned-1",
        description: "PM",
        prompt: "Manage the run.",
        skills: ["pm-skill-a", "pm-skill-b"],
        mcpServers: ["pm-server"],
      };
      const parent = spawn(undefined, {}, "claude-code", {
        ...sourceBody,
        sourceHash: digestVkCompiledMainAgentSource(sourceBody),
      });
      const child = spawn(
        { skills: { mode: "allow", names: ["writer-practices", "karpathy-guidelines", "picked-skill"] } },
        { parentThreadId: parent.id },
        "codex",
      );
      const policy = readVkRequiredSessionPolicy(db, child.id)!.policy;
      for (const name of ["writer-practices", "karpathy-guidelines", "picked-skill"]) {
        expect(vkPolicyAllows(policy.skills, name), name).toBe(true);
      }
      expect(vkPolicyAllows(policy.skills, "pm-skill-a")).toBe(false);
      expect(policy.mcpServers).toBeUndefined();
    } finally {
      db.$client.close();
    }
  });

  it("inherits a compiled parent's explicit request as the ceiling, not its agent selection", () => {
    const { db, spawn } = setup();
    try {
      const sourceBody = {
        id: "pm",
        sourceVersion: "lp-owned-1",
        description: "PM",
        prompt: "Manage the run.",
        skills: ["pm-skill-a"],
      };
      const parent = spawn(
        { skills: { mode: "allow", names: ["ceiling-skill"] }, projectInstructions: false },
        {},
        "claude-code",
        { ...sourceBody, sourceHash: digestVkCompiledMainAgentSource(sourceBody) },
      );
      const child = spawn(
        { skills: { mode: "allow", names: ["ceiling-skill", "other-skill"] } },
        { parentThreadId: parent.id },
      );
      const policy = readVkRequiredSessionPolicy(db, child.id)!.policy;
      expect(vkPolicyAllows(policy.skills, "ceiling-skill")).toBe(true);
      expect(vkPolicyAllows(policy.skills, "other-skill")).toBe(false);
      expect(vkPolicyAllows(policy.skills, "pm-skill-a")).toBe(false);
      expect(policy.projectInstructions).toBe(false);
    } finally {
      db.$client.close();
    }
  });

  it("reads a pre-ceiling compiled parent's row as its own policy, not as a ceiling", () => {
    const { db, spawn } = setup();
    try {
      const sourceBody = {
        id: "pm",
        sourceVersion: "lp-owned-1",
        description: "PM",
        prompt: "Manage the run.",
        skills: ["pm-skill-a", "pm-skill-b"],
        mcpServers: ["pm-server"],
      };
      const parent = spawn({ claudeAiSync: false }, {}, "claude-code", {
        ...sourceBody,
        sourceHash: digestVkCompiledMainAgentSource(sourceBody),
      });
      const policyRow = and(
        eq(threadPluginMetadata.threadId, parent.id),
        eq(threadPluginMetadata.pluginId, "__vk.required-session-policy"),
      );
      // The shape rows had before `ceiling` existed: explicit request ∩ agent selection in `policy`.
      const legacy = {
        version: 1 as const,
        policy: {
          claudeAiSync: false,
          skills: { mode: "allow" as const, names: ["pm-skill-a", "pm-skill-b"] },
          mcpServers: { mode: "allow" as const, names: ["pm-server"] },
        },
      };
      db.update(threadPluginMetadata).set({ metadataJson: JSON.stringify(legacy) }).where(policyRow).run();
      writeVkThreadMarker(db, parent.id, VK_REQUIRED_SESSION_POLICY_MARKER_ID, {
        snapshotDigest: vkRequiredSessionPolicyDigest(legacy),
      });
      const child = spawn(
        { skills: { mode: "allow", names: ["writer-practices", "pm-skill-a"] } },
        { parentThreadId: parent.id },
      );
      const policy = readVkRequiredSessionPolicy(db, child.id)!.policy;
      expect(vkPolicyAllows(policy.skills, "writer-practices")).toBe(true);
      expect(vkPolicyAllows(policy.skills, "pm-skill-a")).toBe(true);
      expect(policy.claudeAiSync).toBe(false);
      expect(policy.mcpServers).toBeUndefined();

      // A clause with a name outside the agent's selection may carry an explicit restriction: it stays.
      const mixed = {
        version: 1 as const,
        policy: { skills: { mode: "allow" as const, names: ["pm-skill-a", "outside-skill"] } },
      };
      db.update(threadPluginMetadata).set({ metadataJson: JSON.stringify(mixed) }).where(policyRow).run();
      writeVkThreadMarker(db, parent.id, VK_REQUIRED_SESSION_POLICY_MARKER_ID, {
        snapshotDigest: vkRequiredSessionPolicyDigest(mixed),
      });
      const restricted = spawn(
        { skills: { mode: "allow", names: ["outside-skill", "other-skill"] } },
        { parentThreadId: parent.id },
      );
      const restrictedPolicy = readVkRequiredSessionPolicy(db, restricted.id)!.policy;
      expect(vkPolicyAllows(restrictedPolicy.skills, "outside-skill")).toBe(true);
      expect(vkPolicyAllows(restrictedPolicy.skills, "other-skill")).toBe(false);

      // An allow clause with zero names is an explicit "nothing" ceiling, never agent-derived: it stays.
      const none = {
        version: 1 as const,
        policy: { skills: { mode: "allow" as const, names: [] as string[] } },
      };
      db.update(threadPluginMetadata).set({ metadataJson: JSON.stringify(none) }).where(policyRow).run();
      writeVkThreadMarker(db, parent.id, VK_REQUIRED_SESSION_POLICY_MARKER_ID, {
        snapshotDigest: vkRequiredSessionPolicyDigest(none),
      });
      const denied = spawn(
        { skills: { mode: "allow", names: ["writer-practices"] } },
        { parentThreadId: parent.id },
      );
      const deniedPolicy = readVkRequiredSessionPolicy(db, denied.id)!.policy;
      expect(vkPolicyAllows(deniedPolicy.skills, "writer-practices")).toBe(false);
    } finally {
      db.$client.close();
    }
  });

  it("still rejects an explicitly selected compiled MAIN role on an unsupported provider", () => {
    const { db, spawn } = setup();
    try {
      const sourceBody = {
        id: "copy-lead",
        sourceVersion: "lp-owned-1",
        description: "Copy lead",
        prompt: "Write clearly.",
      };
      const explicit = {
        ...sourceBody,
        sourceHash: digestVkCompiledMainAgentSource(sourceBody),
      };
      const parent = spawn(undefined, {}, "claude-code", explicit);
      expect(
        () => spawn(undefined, { parentThreadId: parent.id }, "codex", explicit),
      ).toThrow(
        "vk_compiled_main_agent_unsupported_provider",
      );
      expect(db.select().from(threads).all()).toHaveLength(1);
    } finally {
      db.$client.close();
    }
  });

  it("rejects child creation when a compiled parent has lost both required-policy rows", () => {
    const { db, spawn } = setup();
    try {
      const sourceBody = {
        id: "copy-lead",
        sourceVersion: "lp-owned-1",
        description: "Copy lead",
        prompt: "Write clearly.",
      };
      const parent = spawn(undefined, {}, "claude-code", {
        ...sourceBody,
        sourceHash: digestVkCompiledMainAgentSource(sourceBody),
      });
      db.delete(threadPluginMetadata)
        .where(and(eq(threadPluginMetadata.threadId, parent.id), eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_MARKER_ID)))
        .run();
      db.delete(threadPluginMetadata)
        .where(
          and(
            eq(threadPluginMetadata.threadId, parent.id),
            eq(threadPluginMetadata.pluginId, "__vk.required-session-policy"),
          ),
        )
        .run();

      expect(
        () => spawn(undefined, { parentThreadId: parent.id }, "codex"),
      ).toThrow(
        "vk_required_session_policy_dropped",
      );
      expect(db.select().from(threads).all()).toHaveLength(1);
      expect(db.select().from(threadPluginMetadata).where(eq(threadPluginMetadata.pluginId, VK_COMPILED_MAIN_AGENT_MARKER_ID)).all()).toHaveLength(1);
    } finally {
      db.$client.close();
    }
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
      if (failure === "marker") db.delete(threadPluginMetadata).where(and(eq(threadPluginMetadata.threadId, thread.id), eq(threadPluginMetadata.pluginId, VK_REQUIRED_SESSION_POLICY_MARKER_ID))).run();
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
