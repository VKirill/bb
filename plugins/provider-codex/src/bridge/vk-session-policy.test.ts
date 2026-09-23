import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexVkLaunchArgs } from "./vk-session-policy.js";

// VK EXPERIMENTAL: the Codex half of a session policy.

function skill(dir: string, name?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    name ? `---\nname: ${name}\ndescription: d\n---\nbody` : "x",
  );
}

function fixture(): { codexHome: string; home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "vk-codex-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "vk-codex-cwd-"));
  const codexHome = join(home, ".codex");
  skill(join(codexHome, "skills", "ru-text"));
  skill(join(codexHome, "skills", ".system", "imagegen"));
  skill(join(home, ".agents", "skills", "google"));
  skill(join(home, ".agents", "skills", "google", "google-ads"));
  skill(
    join(
      codexHome,
      "plugins",
      "cache",
      "market",
      "canva",
      "1.0.0",
      "skills",
      "brand-check",
    ),
  );
  skill(
    join(
      codexHome,
      "plugins",
      "cache",
      "market",
      "slides",
      "2.0.0",
      "skills",
      "slides",
    ),
    "Presentations",
  );
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      'model = "gpt"',
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      "[mcp_servers.gitnexus]",
      'command = "gitnexus"',
      "[mcp_servers.gitnexus.env]",
      'A = "1"',
      "[mcp_servers.discord-web]",
      'url = "http://x"',
    ].join("\n"),
  );
  return { codexHome, home, cwd };
}

function skillsConfig(args: string[]): string {
  return args.find((arg) => arg.startsWith("skills.config=")) ?? "";
}

describe("buildCodexVkLaunchArgs", () => {
  it("disables dropped MCP servers and plugins", () => {
    const { codexHome, home, cwd } = fixture();
    const args = buildCodexVkLaunchArgs({
      codexHome,
      home,
      cwd,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["gitnexus"] },
        nativePlugins: { mode: "deny", names: ["browser"] },
      },
    });
    expect(args).toEqual([
      "-c",
      "mcp_servers.discord-web.enabled=false",
      "-c",
      "plugins.browser@openai-bundled.enabled=false",
    ]);
  });

  it("disables nested, bundled and plugin skills outside an allow list", () => {
    const { codexHome, home, cwd } = fixture();
    const config = skillsConfig(
      buildCodexVkLaunchArgs({
        codexHome,
        home,
        cwd,
        policy: { version: 1, skills: { mode: "allow", names: ["ru-text"] } },
      }),
    );
    expect(config).toContain(
      join(home, ".agents", "skills", "google", "SKILL.md"),
    );
    expect(config).toContain(
      join(home, ".agents", "skills", "google", "google-ads", "SKILL.md"),
    );
    expect(config).toContain(
      join(codexHome, "skills", ".system", "imagegen", "SKILL.md"),
    );
    expect(config).toContain('{name="canva:brand-check",enabled=false}');
    expect(config).toContain('{name="slides:Presentations",enabled=false}');
    expect(config).not.toContain("ru-text");
  });

  it("matches plugin skills by bare name in a deny list", () => {
    const { codexHome, home, cwd } = fixture();
    const config = skillsConfig(
      buildCodexVkLaunchArgs({
        codexHome,
        home,
        cwd,
        policy: {
          version: 1,
          skills: { mode: "deny", names: ["brand-check"] },
        },
      }),
    );
    expect(config).toBe(
      'skills.config=[{name="canva:brand-check",enabled=false}]',
    );
  });

  it("adds nothing for a policy without native parts", () => {
    const { codexHome, home, cwd } = fixture();
    expect(
      buildCodexVkLaunchArgs({ codexHome, home, cwd, policy: { version: 1 } }),
    ).toEqual([]);
  });
});
