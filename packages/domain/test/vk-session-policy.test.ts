import { describe, expect, it } from "vitest";
import {
  readVkRuntimeSessionPolicy,
  intersectVkSessionPolicies,
  vkRequiredSessionPolicySchema,
  vkPolicyAllows,
  vkSessionPolicySchema,
  type VkSessionPolicy,
} from "../src/vk-session-policy.js";

describe("vk session policy", () => {
  it("lets everything through without a filter", () => {
    expect(vkPolicyAllows(undefined, "anything")).toBe(true);
  });

  it("keeps only listed names in allow mode, with prefix wildcards", () => {
    const filter = {
      mode: "allow" as const,
      names: ["ru-text", "lane-stack:*"],
    };
    expect(vkPolicyAllows(filter, "ru-text")).toBe(true);
    expect(vkPolicyAllows(filter, "lane-stack:web-design")).toBe(true);
    expect(vkPolicyAllows(filter, "agency")).toBe(false);
  });

  it("drops listed names in deny mode, matching any spelling", () => {
    const filter = { mode: "deny" as const, names: ["web-design"] };
    expect(vkPolicyAllows(filter, "lane-stack:web-design", "web-design")).toBe(
      false,
    );
    expect(vkPolicyAllows(filter, "ru-text")).toBe(true);
  });

  it("reads the runtime policy from provider options and ignores junk", () => {
    const policy = { version: 1, bbSkillsDenied: ["agency"] };
    expect(readVkRuntimeSessionPolicy({ vkSessionPolicy: policy })).toEqual(
      policy,
    );
    expect(
      readVkRuntimeSessionPolicy({ vkSessionPolicy: { version: 2 } }),
    ).toBeNull();
    expect(readVkRuntimeSessionPolicy({})).toBeNull();
    expect(readVkRuntimeSessionPolicy(null)).toBeNull();
  });

  it("rejects unknown filter modes", () => {
    expect(
      vkSessionPolicySchema.safeParse({ skills: { mode: "only", names: [] } })
        .success,
    ).toBe(false);
  });
});

describe("required policy contract", () => {
  it("rejects unsupported fields and versions at the boundary", () => {
    expect(() =>
      vkRequiredSessionPolicySchema.parse({ version: 2, policy: {} }),
    ).toThrow();
    expect(() =>
      vkRequiredSessionPolicySchema.parse({
        version: 1,
        policy: { inventedSetting: true },
      }),
    ).toThrow();
    expect(() =>
      readVkRuntimeSessionPolicy({
        vkRequiredSessionPolicy: 1,
        vkSessionPolicy: { version: 1, required: true, inventedSetting: true },
      }),
    ).toThrow();
  });
  it("intersects alias and prefix clauses without child all widening parent", () => {
    const policy = intersectVkSessionPolicies([
      { skills: { mode: "allow", names: ["plugin:*"] } },
      { skills: { mode: "allow", names: ["reader"] } },
      { skills: { mode: "deny", names: ["secret"] } },
      {},
    ]);
    expect(vkPolicyAllows(policy.skills, "plugin:reader", "reader")).toBe(true);
    expect(vkPolicyAllows(policy.skills, "plugin:secret", "secret")).toBe(
      false,
    );
    expect(vkPolicyAllows(policy.skills, "other:reader", "reader")).toBe(false);
  });
});

describe("claude.ai sync off on providers without it", () => {
  it("is satisfied, not refused", async () => {
    const { assertVkRequiredPolicyProvider } = await import("../src/vk-session-policy.js");
    for (const provider of ["codex", "acp-opencode", "acp-cursor"]) {
      expect(() => assertVkRequiredPolicyProvider(provider, { claudeAiSync: false })).not.toThrow();
    }
  });
});

describe("Cursor and BB skills", () => {
  it("narrows BB skills for Cursor, but still refuses dropping its project instructions", async () => {
    const { assertVkRequiredPolicyProvider } = await import("../src/vk-session-policy.js");
    expect(() => assertVkRequiredPolicyProvider("acp-cursor", { skills: { mode: "allow", names: ["writer-practices"] } })).not.toThrow();
    expect(() => assertVkRequiredPolicyProvider("acp-cursor", { projectInstructions: false })).toThrow(/cursor/);
  });
});

describe("OpenCode v2 required policy", () => {
  it("advertises what the OpenCode v2 bridge enforces and keeps acp-opencode", async () => {
    const { VK_REQUIRED_SESSION_POLICY_CAPABILITY: capability } = await import(
      "../src/vk-session-policy.js"
    );
    expect(Object.keys(capability.providerGroups).sort()).toEqual([
      "acp-cursor",
      "acp-opencode",
      "claude-code",
      "codex",
      "opencode2",
    ]);
    expect(capability.providerGroups.opencode2).toEqual([
      "bbPlugins",
      "skills",
      "mcpServers",
    ]);
    expect(capability.instructionSwitches.opencode2).toEqual([
      "userInstructions",
    ]);
    expect(capability.providerGroups["acp-opencode"]).toEqual([
      "bbPlugins",
      "skills",
      "mcpServers",
    ]);
  });

  it("accepts BB plugins, skills, MCP servers, user instructions and the no-op claude.ai sync", async () => {
    const { assertVkRequiredPolicyProvider } = await import(
      "../src/vk-session-policy.js"
    );
    expect(() =>
      assertVkRequiredPolicyProvider("opencode2", {
        bbPlugins: { mode: "allow", names: ["env-catalog"] },
        skills: { mode: "allow", names: ["alpha"] },
        mcpServers: { mode: "deny", names: ["x"] },
        userInstructions: false,
        claudeAiSync: false,
      }),
    ).not.toThrow();
  });

  it.each<[string, VkSessionPolicy]>([
    ["nativePlugins", { nativePlugins: { mode: "deny", names: ["x"] } }],
    ["projectInstructions", { projectInstructions: false }],
  ])("refuses %s, which OpenCode cannot narrow per session", async (group, policy) => {
    const { assertVkRequiredPolicyProvider } = await import(
      "../src/vk-session-policy.js"
    );
    expect(() => assertVkRequiredPolicyProvider("opencode2", policy)).toThrow(
      `unsupported_opencode2_${group}`,
    );
  });
});
