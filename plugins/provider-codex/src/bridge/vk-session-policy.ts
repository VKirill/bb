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
 * - Skills: one `skills.config=[{path|name, enabled=false}, …]` entry per
 *   native skill the policy drops: skill roots (`$CODEX_HOME/skills` with
 *   `.system`, `~/.agents/skills`, project `.codex/skills` and
 *   `.agents/skills`, walked recursively) and plugin skills.
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
      if (!vkPolicyAllows(args.policy.skills, skill.name, skill.bare)) {
        disabled.push(`{${skill.entry},enabled=false}`);
      }
    }
    if (disabled.length > 0) {
      overrides.push(`skills.config=[${disabled.join(",")}]`);
    }
  }
  // Codex reads no AGENTS.md project doc when its byte budget is zero.
  if (args.policy.projectInstructions === false) {
    overrides.push("project_doc_max_bytes=0");
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

/**
 * Native skills Codex discovers by itself. Skill roots are walked
 * recursively (`~/.agents/skills/<group>/<skill>/SKILL.md`, the bundled
 * `.system` set) and addressed by path; plugin skills are addressed by their
 * invocable `plugin:skill` name, the form Codex writes for them itself.
 */
function listCodexNativeSkills(
  codexHome: string,
  home: string,
  cwd: string,
): { name: string; bare: string; entry: string }[] {
  const skills: { name: string; bare: string; entry: string }[] = [];
  const roots = [
    join(codexHome, "skills"),
    join(home, ".agents", "skills"),
    join(cwd, ".codex", "skills"),
    join(cwd, ".agents", "skills"),
  ];
  for (const root of roots) {
    for (const dir of findSkillDirs(root, 4)) {
      const name = skillName(dir);
      skills.push({
        name,
        bare: name,
        entry: `path=${JSON.stringify(join(dir, "SKILL.md"))}`,
      });
    }
  }
  const cache = join(codexHome, "plugins", "cache");
  for (const market of safeReaddir(cache)) {
    for (const plugin of safeReaddir(join(cache, market))) {
      const versions = safeReaddir(join(cache, market, plugin)).sort();
      const latest = versions[versions.length - 1];
      if (!latest) continue;
      const skillsDir = join(cache, market, plugin, latest, "skills");
      for (const dir of findSkillDirs(skillsDir, 1)) {
        const bare = skillName(dir);
        const name = `${plugin}:${bare}`;
        skills.push({ name, bare, entry: `name=${JSON.stringify(name)}` });
      }
    }
  }
  return skills;
}

/**
 * Directories holding a SKILL.md under `root`. Codex also loads skills nested
 * inside another skill's folder (`google/SKILL.md` and
 * `google/google-ads/SKILL.md`), so the walk continues below a match.
 */
function findSkillDirs(root: string, depth: number): string[] {
  const found: string[] = [];
  for (const name of safeReaddir(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(dir, "SKILL.md"))) found.push(dir);
    if (depth > 1) found.push(...findSkillDirs(dir, depth - 1));
  }
  return found;
}

/** The frontmatter `name` of a skill, else its folder name. */
function skillName(dir: string): string {
  try {
    const head = readFileSync(join(dir, "SKILL.md"), "utf8").slice(0, 2000);
    const match = /^---\s*\n([\s\S]*?)\n---/u.exec(head);
    const name = match?.[1]
      ?.split("\n")
      .map((line) => /^name:\s*["']?([^"'\n]+?)["']?\s*$/u.exec(line)?.[1])
      .find((value) => value !== undefined);
    if (name) return name.trim();
  } catch {
    // Fall through to the folder name.
  }
  return dir.slice(dir.lastIndexOf("/") + 1);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
