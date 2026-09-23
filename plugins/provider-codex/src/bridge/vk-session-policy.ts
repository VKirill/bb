import {
  vkPolicyAllows,
  type VkRuntimeSessionPolicy,
} from "@get-bb/plugin-sdk/provider-bridge";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Turns the bridge half of a session policy into `codex app-server -c`
 * overrides. Every BB thread runs its own app-server child, so launch-level
 * overrides are per thread and reach every Codex subsystem (MCP manager,
 * skills manager, plugin loader) the same way the user's config.toml does:
 *
 * - MCP servers: `mcp_servers.<name>.enabled=false` for each server of
 *   `$CODEX_HOME/config.toml` the policy drops.
 * - Native plugins: `plugins.<id>.enabled=false`.
 * - Skills: one `skills.config=[{path, enabled=false}, …]` entry per native
 *   skill (`$CODEX_HOME/skills`, `~/.agents/skills`, project `.codex/skills`
 *   and `.agents/skills`) the policy drops.
 *
 * Codex splits an override key on "." without honouring TOML quotes, so an
 * id is written raw and an id that itself contains "." cannot be addressed
 * and is skipped.
 */
export function buildCodexVkLaunchArgs(args: {
  codexHome?: string;
  cwd: string;
  home?: string;
  policy: VkRuntimeSessionPolicy;
}): string[] {
  const home = args.home ?? homedir();
  const codexHome =
    args.codexHome ?? process.env.CODEX_HOME ?? join(home, ".codex");
  const config = readTomlTableNames(join(codexHome, "config.toml"));
  const overrides: string[] = [];

  if (args.policy.mcpServers) {
    for (const name of config.mcpServers) {
      if (
        !name.includes(".") &&
        !vkPolicyAllows(args.policy.mcpServers, name)
      ) {
        overrides.push(`mcp_servers.${name}.enabled=false`);
      }
    }
  }
  if (args.policy.nativePlugins) {
    for (const id of config.plugins) {
      const name = id.split("@")[0] ?? id;
      if (
        !id.includes(".") &&
        !vkPolicyAllows(args.policy.nativePlugins, id, name)
      ) {
        overrides.push(`plugins.${id}.enabled=false`);
      }
    }
  }
  if (args.policy.skills) {
    const disabled: string[] = [];
    for (const skill of listCodexNativeSkills(codexHome, home, args.cwd)) {
      if (!vkPolicyAllows(args.policy.skills, skill.name)) {
        disabled.push(`{path=${JSON.stringify(skill.path)},enabled=false}`);
      }
    }
    if (disabled.length > 0) {
      overrides.push(`skills.config=[${disabled.join(",")}]`);
    }
  }
  return overrides.flatMap((override) => ["-c", override]);
}

/**
 * The `[mcp_servers.<name>]` and `[plugins.<id>]` table names of a
 * config.toml. A line scan is enough: these tables are always written as
 * headers, and a missing or unreadable file means nothing to disable.
 */
function readTomlTableNames(path: string): {
  mcpServers: string[];
  plugins: string[];
} {
  const mcpServers = new Set<string>();
  const plugins = new Set<string>();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { mcpServers: [], plugins: [] };
  }
  for (const line of text.split(/\r?\n/u)) {
    const header =
      /^\s*\[\s*(mcp_servers|plugins)\s*\.\s*("([^"]+)"|([^.\]\s]+))/u.exec(
        line,
      );
    if (!header) continue;
    const name = header[3] ?? header[4];
    if (!name) continue;
    (header[1] === "mcp_servers" ? mcpServers : plugins).add(name);
  }
  return { mcpServers: [...mcpServers], plugins: [...plugins] };
}

function listCodexNativeSkills(
  codexHome: string,
  home: string,
  cwd: string,
): { name: string; path: string }[] {
  const roots = [
    join(codexHome, "skills"),
    join(home, ".agents", "skills"),
    join(cwd, ".codex", "skills"),
    join(cwd, ".agents", "skills"),
  ];
  const skills: { name: string; path: string }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const skillFile = join(root, name, "SKILL.md");
      try {
        if (statSync(join(root, name)).isDirectory() && existsSync(skillFile)) {
          skills.push({ name, path: skillFile });
        }
      } catch {
        // An unreadable entry is not a skill Codex could load either.
      }
    }
  }
  return skills;
}
