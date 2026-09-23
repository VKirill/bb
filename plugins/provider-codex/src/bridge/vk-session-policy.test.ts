import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexVkLaunchArgs } from "./vk-session-policy.js";

// VK EXPERIMENTAL: the Codex half of a session policy.

function fixture(): { codexHome: string; home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "vk-codex-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "vk-codex-cwd-"));
  const codexHome = join(home, ".codex");
  mkdirSync(join(codexHome, "skills", "ru-text"), { recursive: true });
  writeFileSync(join(codexHome, "skills", "ru-text", "SKILL.md"), "x");
  mkdirSync(join(home, ".agents", "skills", "web-design"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "web-design", "SKILL.md"), "x");
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

describe("buildCodexVkLaunchArgs", () => {
  it("disables dropped MCP servers, plugins and native skills", () => {
    const { codexHome, home, cwd } = fixture();
    const args = buildCodexVkLaunchArgs({
      codexHome,
      home,
      cwd,
      policy: {
        version: 1,
        mcpServers: { mode: "allow", names: ["gitnexus"] },
        nativePlugins: { mode: "deny", names: ["browser"] },
        skills: { mode: "allow", names: ["ru-text"] },
      },
    });
    expect(args).toEqual([
      "-c",
      "mcp_servers.discord-web.enabled=false",
      "-c",
      "plugins.browser@openai-bundled.enabled=false",
      "-c",
      `skills.config=[{path=${JSON.stringify(
        join(home, ".agents", "skills", "web-design", "SKILL.md"),
      )},enabled=false}]`,
    ]);
  });

  it("adds nothing for a policy without native parts", () => {
    const { codexHome, home, cwd } = fixture();
    expect(
      buildCodexVkLaunchArgs({ codexHome, home, cwd, policy: { version: 1 } }),
    ).toEqual([]);
  });
});
