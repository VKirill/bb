import type { McpServerConfig, Settings } from "@anthropic-ai/claude-agent-sdk";
import {
  vkPolicyAllows,
  type VkPolicyFilter,
  type VkRuntimeSessionPolicy,
} from "@get-bb/plugin-sdk/provider-bridge";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Turns the bridge half of a session policy into Claude Agent SDK options.
 * Claude loads its own MCP servers, skills and plugins from the user's
 * settings, so the policy is enforced through documented switches rather
 * than by hiding files:
 *
 * - MCP `allow`: `strictMcpConfig` plus the allowed server configs copied from
 *   `~/.claude.json` (user and local scope) and `<cwd>/.mcp.json`. Servers a
 *   Claude plugin ships are not copied, so an allow list drops them.
 * - MCP `deny`: flag-layer `deniedMcpServers`.
 * - Skills `allow`: the SDK `skills` allow list (hides the rest from the
 *   listing and denies invocation).
 * - Skills `deny`: `skillOverrides: off` for personal/project skills plus a
 *   `Skill(name)` deny rule, which is the only switch plugin skills obey.
 * - Native plugins: flag-layer `enabledPlugins: { id: false }`.
 */
export interface ClaudeVkSessionOptions {
  disallowedTools: string[];
  flagSettings: Settings;
  mcpServers: Record<string, McpServerConfig>;
  skills: string[] | null;
  strictMcpConfig: boolean;
}

interface ClaudeNativeInventory {
  /** name → config, nearest scope last (local beats project beats user). */
  mcpServers: Map<string, McpServerConfig>;
  /** enabled plugin ids (`name@marketplace`) → plugin name. */
  plugins: Map<string, string>;
  /** invocable skill names: bare for personal/project, `plugin:skill` else. */
  skills: Set<string>;
  /** the subset of `skills` that are personal or project skills. */
  personalSkills: Set<string>;
}

export function buildClaudeVkSessionOptions(args: {
  bbSkillNames: readonly string[];
  cwd: string;
  home?: string;
  policy: VkRuntimeSessionPolicy;
}): ClaudeVkSessionOptions {
  const inventory = readClaudeNativeInventory(args.cwd, args.home ?? homedir());
  const options: ClaudeVkSessionOptions = {
    disallowedTools: [],
    flagSettings: {},
    mcpServers: {},
    skills: null,
    strictMcpConfig: false,
  };
  applyMcpPolicy(options, args.policy.mcpServers, inventory);
  applyNativePluginPolicy(options, args.policy.nativePlugins, inventory);
  applySkillPolicy(options, args.policy.skills, inventory, args.bbSkillNames);
  return options;
}

function applyMcpPolicy(
  options: ClaudeVkSessionOptions,
  filter: VkPolicyFilter | undefined,
  inventory: ClaudeNativeInventory,
): void {
  if (!filter) return;
  if (filter.mode === "allow") {
    options.strictMcpConfig = true;
    for (const [name, config] of inventory.mcpServers) {
      if (vkPolicyAllows(filter, name)) options.mcpServers[name] = config;
    }
    return;
  }
  options.flagSettings.deniedMcpServers = filter.names.map((serverName) => ({
    serverName,
  }));
}

function applyNativePluginPolicy(
  options: ClaudeVkSessionOptions,
  filter: VkPolicyFilter | undefined,
  inventory: ClaudeNativeInventory,
): void {
  if (!filter) return;
  const disabled: Record<string, false> = {};
  for (const [id, name] of inventory.plugins) {
    if (!vkPolicyAllows(filter, id, name)) disabled[id] = false;
  }
  if (Object.keys(disabled).length > 0) {
    options.flagSettings.enabledPlugins = disabled;
  }
}

function applySkillPolicy(
  options: ClaudeVkSessionOptions,
  filter: VkPolicyFilter | undefined,
  inventory: ClaudeNativeInventory,
  bbSkillNames: readonly string[],
): void {
  if (!filter) return;
  if (filter.mode === "allow") {
    const allowed = new Set<string>(bbSkillNames);
    for (const name of inventory.skills) {
      if (vkPolicyAllows(filter, name, bareSkillName(name))) allowed.add(name);
    }
    // Literal names the inventory cannot see (bundled skills) still pass.
    for (const pattern of filter.names) {
      if (!pattern.endsWith("*")) allowed.add(pattern);
    }
    options.skills = [...allowed].sort();
    return;
  }
  const overrides: Record<string, "off"> = {};
  const denied = new Set<string>();
  for (const name of inventory.skills) {
    if (vkPolicyAllows(filter, name, bareSkillName(name))) continue;
    denied.add(name);
    if (inventory.personalSkills.has(name)) overrides[name] = "off";
  }
  for (const pattern of filter.names) {
    if (!pattern.endsWith("*")) denied.add(pattern);
  }
  for (const name of [...denied].sort()) {
    options.disallowedTools.push(`Skill(${name})`, `Skill(${name} *)`);
  }
  if (Object.keys(overrides).length > 0) {
    options.flagSettings.skillOverrides = overrides;
  }
}

function bareSkillName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

function readClaudeNativeInventory(
  cwd: string,
  home: string,
): ClaudeNativeInventory {
  const inventory: ClaudeNativeInventory = {
    mcpServers: new Map(),
    plugins: new Map(),
    skills: new Set(),
    personalSkills: new Set(),
  };
  const claudeJson = readJsonObject(join(home, ".claude.json"));
  addMcpServers(inventory, claudeJson?.mcpServers);
  addMcpServers(inventory, readJsonObject(join(cwd, ".mcp.json"))?.mcpServers);
  const projects = asObject(claudeJson?.projects);
  addMcpServers(inventory, asObject(projects?.[cwd])?.mcpServers);

  for (const dir of [
    join(home, ".claude", "skills"),
    join(cwd, ".claude", "skills"),
  ]) {
    for (const name of listSkillDirs(dir)) {
      inventory.skills.add(name);
      inventory.personalSkills.add(name);
    }
  }

  const enabled = {
    ...asObject(
      readJsonObject(join(home, ".claude", "settings.json"))?.enabledPlugins,
    ),
    ...asObject(
      readJsonObject(join(cwd, ".claude", "settings.json"))?.enabledPlugins,
    ),
  };
  const installed = asObject(
    readJsonObject(join(home, ".claude", "plugins", "installed_plugins.json"))
      ?.plugins,
  );
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installs = installed?.[id];
    const installPath = Array.isArray(installs)
      ? asObject(installs[0])?.installPath
      : undefined;
    const manifestName =
      typeof installPath === "string"
        ? readJsonObject(join(installPath, ".claude-plugin", "plugin.json"))
            ?.name
        : undefined;
    const name =
      typeof manifestName === "string" ? manifestName : id.split("@")[0]!;
    inventory.plugins.set(id, name);
    if (typeof installPath === "string") {
      for (const skill of listSkillDirs(join(installPath, "skills"))) {
        inventory.skills.add(`${name}:${skill}`);
      }
    }
  }
  return inventory;
}

function addMcpServers(inventory: ClaudeNativeInventory, raw: unknown): void {
  const servers = asObject(raw);
  if (!servers) return;
  for (const [name, config] of Object.entries(servers)) {
    if (asObject(config)) {
      inventory.mcpServers.set(name, config as McpServerConfig);
    }
  }
}

function listSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return (
          statSync(join(dir, name)).isDirectory() &&
          existsSync(join(dir, name, "SKILL.md"))
        );
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The invocable names of the BB skills a session's local skill plugins
 * carry (`bb-global-skills:ru-text`), read back from the plugins as built.
 */
export function listClaudeBbSkillNames(
  plugins: readonly { path: string }[] | undefined,
): string[] {
  const names: string[] = [];
  for (const plugin of plugins ?? []) {
    const name = readJsonObject(
      join(plugin.path, ".claude-plugin", "plugin.json"),
    )?.name;
    if (typeof name !== "string") continue;
    for (const skill of listSkillDirs(join(plugin.path, "skills"))) {
      names.push(`${name}:${skill}`);
    }
  }
  return names;
}
