import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAcpVkEnv, vkFilterAcpSkillRoots } from "./vk-session-policy.js";

// VK EXPERIMENTAL: the ACP half of a session policy.

describe("ACP vk session policy", () => {
  it("drops denied BB skills from the instruction list", () => {
    const roots = [
      {
        id: "global",
        skillDirectoryRootPath: "/skills",
        skills: [
          { name: "ru-text", description: "a" },
          { name: "agency", description: "b" },
        ],
      },
    ];
    expect(
      vkFilterAcpSkillRoots(roots, {
        version: 1,
        bbSkillsDenied: ["agency"],
      })?.[0]?.skills.map((skill) => skill.name),
    ).toEqual(["ru-text"]);
    expect(vkFilterAcpSkillRoots(null, null)).toBeUndefined();
  });

  it("builds an OpenCode config overlay and merges an existing one", () => {
    const home = mkdtempSync(join(tmpdir(), "vk-acp-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "vk-acp-cwd-"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "opencode.jsonc"),
      '{\n  // servers\n  "mcp": { "gitnexus": {}, "metamcp": {}, },\n}',
    );
    const env = buildAcpVkEnv({
      cwd,
      dialectId: "opencode",
      envVars: { OPENCODE_CONFIG_CONTENT: '{"model":"x","mcp":{"a":{}}}' },
      home,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["gitnexus"] },
        skills: { mode: "allow", names: ["ru-text"] },
      },
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      model: "x",
      mcp: { a: {}, metamcp: { enabled: false } },
      permission: { skill: { "*": "deny", "ru-text": "allow" } },
    });
  });

  it("leaves Cursor and policy-free sessions alone", () => {
    const policy = {
      version: 1 as const,
      skills: { mode: "deny" as const, names: ["x"] },
    };
    expect(
      buildAcpVkEnv({
        cwd: "/",
        dialectId: "cursor",
        envVars: undefined,
        policy,
      }),
    ).toEqual({});
    expect(
      buildAcpVkEnv({
        cwd: "/",
        dialectId: "opencode",
        envVars: undefined,
        policy: null,
      }),
    ).toEqual({});
  });
});
