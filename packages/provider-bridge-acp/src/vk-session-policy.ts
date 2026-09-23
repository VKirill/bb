import {
  vkPolicyAllows,
  type VkRuntimeSessionPolicy,
} from "@bb/domain/vk-session-policy";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AcpSkillRoot } from "./session-params.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * ACP agents get BB skills as a text list in their instructions, so a
 * policy drops denied BB skills from that list. What the agent loads by
 * itself is narrowed per agent where the agent offers a per-process switch:
 *
 * - OpenCode: `OPENCODE_CONFIG_CONTENT` (merged last over every other config
 *   layer) carries `mcp.<name>.enabled=false` for dropped MCP servers and a
 *   `permission.skill` map; OpenCode removes a skill whose permission
 *   evaluates to `deny` from the listing.
 * - Cursor and other ACP agents: no per-process switch exists for skills or
 *   MCP servers, so only the BB side (plugins, instructions, tools, BB
 *   skills) applies.
 */
export function vkFilterAcpSkillRoots(
  skillRoots: readonly AcpSkillRoot[] | null,
  policy: VkRuntimeSessionPolicy | null,
): AcpSkillRoot[] | undefined {
  if (skillRoots === null) return undefined;
  const denied = new Set(policy?.bbSkillsDenied ?? []);
  if (denied.size === 0) return [...skillRoots];
  return skillRoots.map((root) => ({
    ...root,
    skills: root.skills.filter((skill) => !denied.has(skill.name)),
  }));
}

/** Extra child env for one ACP session, or an empty record. */
export function buildAcpVkEnv(args: {
  cwd: string;
  dialectId: string | undefined;
  envVars: Readonly<Record<string, string>> | undefined;
  home?: string;
  policy: VkRuntimeSessionPolicy | null;
}): Record<string, string> {
  if (args.policy === null || args.dialectId !== "opencode") return {};
  const overlay = buildOpenCodeOverlay(
    args.policy,
    args.cwd,
    args.home ?? homedir(),
    args.envVars,
  );
  if (Object.keys(overlay).length === 0) return {};
  const existing = parseJsonObject(args.envVars?.OPENCODE_CONFIG_CONTENT);
  const merged = {
    ...existing,
    ...overlay,
    ...(overlay.mcp || existing.mcp
      ? { mcp: { ...asObject(existing.mcp), ...asObject(overlay.mcp) } }
      : {}),
    ...(overlay.permission || existing.permission
      ? {
          permission: {
            ...asObject(existing.permission),
            ...asObject(overlay.permission),
          },
        }
      : {}),
  };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(merged) };
}

function buildOpenCodeOverlay(
  policy: VkRuntimeSessionPolicy,
  cwd: string,
  home: string,
  envVars: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};
  if (policy.mcpServers) {
    const known = new Set(readOpenCodeMcpNames(cwd, home, envVars));
    if (policy.mcpServers.mode === "deny") {
      for (const name of policy.mcpServers.names) {
        if (!name.endsWith("*")) known.add(name);
      }
    }
    const mcp: Record<string, { enabled: false }> = {};
    for (const name of known) {
      if (!vkPolicyAllows(policy.mcpServers, name))
        mcp[name] = { enabled: false };
    }
    if (Object.keys(mcp).length > 0) overlay.mcp = mcp;
  }
  if (policy.skills) {
    // OpenCode: the last matching rule wins, and `*` is a wildcard.
    const skill: Record<string, "allow" | "deny"> =
      policy.skills.mode === "allow" ? { "*": "deny" } : {};
    for (const name of policy.skills.names) {
      skill[name] = policy.skills.mode === "allow" ? "allow" : "deny";
    }
    overlay.permission = { skill };
  }
  return overlay;
}

/** MCP server names from the global and project OpenCode config files. */
function readOpenCodeMcpNames(
  cwd: string,
  home: string,
  envVars: Readonly<Record<string, string>> | undefined,
): string[] {
  const configHome =
    envVars?.XDG_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    path.join(home, ".config");
  const files = [
    path.join(configHome, "opencode", "opencode.json"),
    path.join(configHome, "opencode", "opencode.jsonc"),
    path.join(cwd, "opencode.json"),
    path.join(cwd, "opencode.jsonc"),
    path.join(cwd, ".opencode", "opencode.json"),
    path.join(cwd, ".opencode", "opencode.jsonc"),
  ];
  const names = new Set<string>();
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const mcp = asObject(parseJsonObject(stripJsonComments(text)).mcp);
    for (const name of Object.keys(mcp)) names.add(name);
  }
  return [...names];
}

/** Drops `//` and `/* *\/` comments outside strings; enough for JSONC config. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/gu, "$1");
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    return asObject(JSON.parse(text));
  } catch {
    return {};
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
