import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionOptions } from "./session-options.js";
import {
  buildClaudeVkSessionOptions,
  claudeMdExcludePatterns,
} from "./vk-session-policy.js";

// VK EXPERIMENTAL: the Claude half of a session policy.

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function skill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

function fixture(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "vk-claude-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "vk-claude-cwd-"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        gitnexus: { command: "gitnexus", args: ["mcp"] },
        "discord-web": { type: "http", url: "http://localhost:1/mcp" },
      },
      projects: { [cwd]: { mcpServers: { local: { command: "local" } } } },
    }),
  );
  skill(join(home, ".claude", "skills"), "ru-text");
  skill(join(home, ".claude", "skills"), "web-design");
  const install = join(home, "plugin-install");
  mkdirSync(join(install, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(install, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "lane-stack" }),
  );
  skill(join(install, "skills"), "browser-qa");
  writeFileSync(
    join(install, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        winnow: {
          command: "uv",
          args: ["--project", "${CLAUDE_PLUGIN_ROOT}/winnow"],
          env: { URL: "${VK_TEST_UNSET_VAR:-http://localhost:3111}" },
        },
      },
    }),
  );
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      enabledPlugins: { "lane-stack@market": true, "remotion@remotion": true },
    }),
  );
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "lane-stack@market": [{ installPath: install }] },
    }),
  );
  return { home, cwd };
}

function writeCustomProfile(root: string): void {
  const install = join(root, "plugin-install");
  mkdirSync(join(install, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(install, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "custom-only" }),
  );
  skill(join(install, "skills"), "custom-skill");
  mkdirSync(join(root, "plugins"), { recursive: true });
  writeFileSync(
    join(root, "settings.json"),
    JSON.stringify({ enabledPlugins: { "custom-only@market": true } }),
  );
  writeFileSync(
    join(root, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "custom-only@market": [{ installPath: install }] },
    }),
  );
}

function customProfile(): { configDir: string } {
  const configDir = tempDir("vk-claude-profile-");
  writeCustomProfile(configDir);
  return { configDir };
}

describe("buildClaudeVkSessionOptions", () => {
  it("copies only allowed MCP servers and turns on strict MCP config", () => {
    const { home, cwd } = fixture();
    const options = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["gitnexus", "local"] },
      },
    });
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers).sort()).toEqual([
      "gitnexus",
      "local",
    ]);
  });

  it("denies MCP servers through the flag layer", () => {
    const { home, cwd } = fixture();
    const options = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: {
        version: 1,
        mcpServers: { mode: "deny", names: ["discord-web"] },
      },
    });
    expect(options.strictMcpConfig).toBe(false);
    expect(options.flagSettings.deniedMcpServers).toEqual([
      { serverName: "discord-web" },
    ]);
  });

  it("builds a skill allow list from native, plugin and BB names", () => {
    const { home, cwd } = fixture();
    const options = buildClaudeVkSessionOptions({
      bbSkillNames: ["bb-global-skills:agency"],
      cwd,
      home,
      policy: {
        version: 1,
        skills: { mode: "allow", names: ["ru-text", "lane-stack:*"] },
      },
    });
    expect(options.skills).toEqual([
      "bb-global-skills:agency",
      "lane-stack:browser-qa",
      "ru-text",
    ]);
  });

  it("hides denied personal skills and blocks plugin skills by rule", () => {
    const { home, cwd } = fixture();
    const options = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: {
        version: 1,
        skills: { mode: "deny", names: ["web-design", "browser-qa"] },
      },
    });
    expect(options.flagSettings.skillOverrides).toEqual({
      "web-design": "off",
    });
    expect(options.disallowedTools).toContain("Skill(lane-stack:browser-qa)");
    expect(options.disallowedTools).toContain("Skill(web-design)");
  });

  it("disables native plugins the policy drops", () => {
    const { home, cwd } = fixture();
    const options = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: {
        version: 1,
        nativePlugins: { mode: "allow", names: ["lane-stack"] },
      },
    });
    expect(options.flagSettings.enabledPlugins).toEqual({
      "remotion@remotion": false,
    });
  });

  it("hands allowed Claude plugin MCP servers over in strict mode", () => {
    const { home, cwd } = fixture();
    const install = join(home, "plugin-install");
    const byBare = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: { version: 1, mcpServers: { mode: "allow", names: ["winnow"] } },
    });
    expect(byBare.strictMcpConfig).toBe(true);
    expect(byBare.mcpServers.winnow).toEqual({
      command: "uv",
      args: ["--project", `${install}/winnow`],
      env: { URL: "http://localhost:3111" },
    });
    const byFullName = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["plugin:lane-stack:winnow"] },
      },
    });
    expect(Object.keys(byFullName.mcpServers)).toEqual(["winnow"]);
    const pluginOff = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["winnow", "gitnexus"] },
        nativePlugins: { mode: "deny", names: ["lane-stack"] },
      },
    });
    expect(Object.keys(pluginOff.mcpServers)).toEqual(["gitnexus"]);
  });

  it("excludes project instruction files but keeps the user's own", () => {
    const patterns = claudeMdExcludePatterns("/Users/u/work/app", "/Users/u");
    expect(patterns).toContain("/Users/u/work/app/CLAUDE.md");
    expect(patterns).toContain("/Users/u/work/AGENTS.md");
    expect(patterns).toContain("/Users/u/work/app/**/AGENTS.md");
    expect(patterns).toContain("/Users/u/work/.claude/rules/**");
    expect(patterns).not.toContain("/Users/u/.claude/CLAUDE.md");
    expect(patterns).not.toContain("/Users/u/.claude/rules/**");
  });

  it("turns off project instructions and claude.ai sync through flags", () => {
    const { home, cwd } = fixture();
    const flags = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: { version: 1, projectInstructions: false, claudeAiSync: false },
    }).flagSettings as Record<string, unknown>;
    expect(flags.claudeMdExcludes).toEqual(claudeMdExcludePatterns(cwd, home));
    expect(flags.syncClaudeAiSkills).toBe(false);
    expect(flags.syncClaudeAiPlugins).toBe(false);
    expect(flags.disableClaudeAiConnectors).toBe(true);
    expect("autoMemoryEnabled" in flags).toBe(false);
  });

  it("turns the user's auto-memory off for a worker under a required policy", () => {
    const { home, cwd } = fixture();
    const flags = buildClaudeVkSessionOptions({
      bbSkillNames: [],
      cwd,
      home,
      policy: { version: 1, required: true },
    }).flagSettings as Record<string, unknown>;
    expect(flags.autoMemoryEnabled).toBe(false);
  });

  it("reads the plugin inventory from the session's Claude config directory, not only ~/.claude", () => {
    const { home, cwd } = fixture();
    const { configDir } = customProfile();
    const build = (nativePlugins: {
      mode: "allow" | "deny";
      names: string[];
    }) =>
      buildClaudeVkSessionOptions({
        bbSkillNames: [],
        configDir,
        cwd,
        home,
        policy: { version: 1, nativePlugins },
      });
    expect(
      build({ mode: "deny", names: ["custom-only"] }).flagSettings
        .enabledPlugins,
    ).toEqual({ "custom-only@market": false });
    expect(
      build({ mode: "allow", names: [] }).flagSettings.enabledPlugins,
    ).toEqual({
      "custom-only@market": false,
    });
    expect(
      build({ mode: "allow", names: ["custom-only"] }).flagSettings
        .enabledPlugins,
    ).toBeUndefined();
    expect(
      buildClaudeVkSessionOptions({
        bbSkillNames: [],
        configDir,
        cwd,
        home,
        policy: {
          version: 1,
          skills: { mode: "allow", names: ["custom-only:*"] },
        },
      }).skills,
    ).toEqual(["custom-only:custom-skill"]);
  });
});

describe("buildSessionOptions Claude config directory", () => {
  const base = {
    instructionMode: "replace" as const,
    permissionMode: "acceptEdits" as const,
    permissionScope: "workspace" as const,
    workflowsEnabled: false,
    serviceTier: "default" as const,
    disable1MContext: false,
    sandboxEnabled: false,
    chromeEnabled: false,
    artifactsEnabled: false,
  };

  it("hands the session CLAUDE_CONFIG_DIR to the policy inventory, absolute and cwd-relative", () => {
    const home = tempDir("vk-claude-home-");
    const cwd = tempDir("vk-claude-session-cwd-");
    const profileDir = join(cwd, "profile");
    mkdirSync(profileDir, { recursive: true });
    writeCustomProfile(profileDir);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const configDir of [profileDir, "profile"]) {
        const build = (nativePlugins: {
          mode: "allow" | "deny";
          names: string[];
        }) =>
          buildSessionOptions(
            {
              ...base,
              cwd,
              vkSessionPolicy: {
                version: 1,
                required: true,
                nativePlugins,
              },
            },
            { CLAUDE_CONFIG_DIR: configDir },
          );
        expect(
          build({ mode: "deny", names: ["custom-only"] }).settings,
        ).toMatchObject({
          enabledPlugins: { "custom-only@market": false },
        });
        expect(
          build({ mode: "allow", names: [] }).settings,
        ).toMatchObject({
          enabledPlugins: { "custom-only@market": false },
        });
        expect(
          build({ mode: "allow", names: ["custom-only"] }).settings,
        ).not.toHaveProperty("enabledPlugins");
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});
