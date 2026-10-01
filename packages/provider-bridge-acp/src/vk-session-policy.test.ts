import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
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

  it("leaves policy-free sessions and unknown agents alone", () => {
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

describe("Cursor vk session policy", () => {
  it("gives Cursor an overlay data dir that disables dropped MCP servers", () => {
    const home = mkdtempSync(join(tmpdir(), "vk-cursor-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "vk-cursor-cwd-"));
    const data = mkdtempSync(join(tmpdir(), "vk-cursor-data-"));
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { gitnexus: {}, metamcp: {}, own: {} } }),
    );
    const slug = realpathSync(cwd)
      .replace(/[^a-zA-Z0-9]/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const realProject = join(data, "projects", slug);
    mkdirSync(join(realProject, "agent-transcripts"), { recursive: true });
    writeFileSync(join(realProject, "mcp-disabled.json"), '["own"]');
    writeFileSync(join(realProject, "mcp-approvals.json"), "[]");

    const env = buildAcpVkEnv({
      cwd: realpathSync(cwd),
      dialectId: "cursor",
      envVars: { CURSOR_DATA_DIR: data },
      home,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["gitnexus"] },
      },
    });
    const overlayProject = join(env.CURSOR_DATA_DIR!, "projects", slug);
    expect(env.CURSOR_DATA_DIR).toContain(join(data, "bb-vk-overlays"));
    expect(
      JSON.parse(
        readFileSync(join(overlayProject, "mcp-disabled.json"), "utf8"),
      ),
    ).toEqual(["metamcp", "own"]);
    expect(
      lstatSync(join(overlayProject, "agent-transcripts")).isSymbolicLink(),
    ).toBe(true);
    expect(
      lstatSync(join(overlayProject, "mcp-approvals.json")).isSymbolicLink(),
    ).toBe(true);
    // The real list is untouched, and the same policy reuses the overlay.
    expect(readFileSync(join(realProject, "mcp-disabled.json"), "utf8")).toBe(
      '["own"]',
    );
    expect(
      buildAcpVkEnv({
        cwd: realpathSync(cwd),
        dialectId: "cursor",
        envVars: { CURSOR_DATA_DIR: data },
        home,
        policy: {
          version: 1,
          mcpServers: { mode: "allow", names: ["gitnexus"] },
        },
      }),
    ).toEqual(env);
  });

  it("leaves Cursor alone when nothing is dropped", () => {
    const home = mkdtempSync(join(tmpdir(), "vk-cursor-home-"));
    expect(
      buildAcpVkEnv({
        cwd: home,
        dialectId: "cursor",
        envVars: undefined,
        home,
        policy: { version: 1, skills: { mode: "allow", names: ["x"] } },
      }),
    ).toEqual({});
  });

  it("skips OpenCode project instructions when they are off", () => {
    expect(
      buildAcpVkEnv({
        cwd: "/",
        dialectId: "opencode",
        envVars: undefined,
        policy: { version: 1, projectInstructions: false },
      }),
    ).toEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: "1" });
  });
});
