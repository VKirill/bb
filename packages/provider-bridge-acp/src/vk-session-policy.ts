import {
  vkPolicyAllows,
  type VkRuntimeSessionPolicy,
} from "@bb/domain/vk-session-policy";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { AcpSkillRoot } from "./session-params.js";
import {
  cursorDataDirectory,
  cursorProjectSlug,
} from "./bridge/cursor-mcp-approval.js";

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
 * - Cursor: MCP servers through a per-policy `CURSOR_DATA_DIR` whose
 *   project folder links everything of the real one (transcripts, approvals,
 *   terminals) except `mcp-disabled.json`, which adds the dropped servers to
 *   the user's own list. Cursor has no per-process switch for skills.
 * - Other ACP agents: only the BB side (plugins, instructions, tools, BB
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
  if (args.policy === null) return {};
  if (args.dialectId === "cursor") {
    return buildCursorVkEnv({
      cwd: args.cwd,
      envVars: args.envVars,
      home: args.home ?? homedir(),
      policy: args.policy,
    });
  }
  if (args.dialectId !== "opencode") return {};
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

/** Folders Cursor fills later; linked up front so new files land in the real one. */
const CURSOR_PROJECT_DIRS = [
  "agent-transcripts",
  "agent-tools",
  "assets",
  "terminals",
];
const CURSOR_DISABLED_FILE = "mcp-disabled.json";

function buildCursorVkEnv(args: {
  cwd: string;
  envVars: Readonly<Record<string, string>> | undefined;
  home: string;
  policy: VkRuntimeSessionPolicy;
}): Record<string, string> {
  const filter = args.policy.mcpServers;
  if (!filter) return {};
  const projectRoot = cursorProjectRoot(args.cwd);
  const known = new Set<string>();
  for (const file of [
    path.join(args.home, ".cursor", "mcp.json"),
    path.join(projectRoot, ".cursor", "mcp.json"),
  ]) {
    for (const name of Object.keys(
      asObject(parseJsonObject(readText(file)).mcpServers),
    ))
      known.add(name);
  }
  if (filter.mode === "deny")
    for (const name of filter.names) if (!name.endsWith("*")) known.add(name);
  const denied = [...known].filter((name) => !vkPolicyAllows(filter, name));
  if (denied.length === 0) return {};

  const realDataDir = cursorDataDirectory({
    ...process.env,
    HOME: args.home,
    ...(args.envVars ?? {}),
  });
  const slug = cursorProjectSlug(projectRoot);
  const realProject = path.join(realDataDir, "projects", slug);
  let own: string[] = [];
  try {
    const parsed: unknown = JSON.parse(
      readText(path.join(realProject, CURSOR_DISABLED_FILE)),
    );
    if (Array.isArray(parsed))
      own = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // No list of the user's own yet.
  }
  const disabled = [...new Set([...own, ...denied])].sort();
  const key = createHash("sha256")
    .update(`${realDataDir}\0${projectRoot}\0${disabled.join("\0")}`)
    .digest("hex")
    .slice(0, 16);
  const overlayRoot = path.join(realDataDir, "bb-vk-overlays", key);
  const overlayProject = path.join(overlayRoot, "projects", slug);
  if (!existsSync(path.join(overlayProject, CURSOR_DISABLED_FILE))) {
    mkdirSync(realProject, { recursive: true });
    for (const dir of CURSOR_PROJECT_DIRS)
      mkdirSync(path.join(realProject, dir), { recursive: true });
    const staging = `${overlayProject}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    for (const entry of readdirSync(realProject)) {
      if (entry === CURSOR_DISABLED_FILE) continue;
      symlinkSync(path.join(realProject, entry), path.join(staging, entry));
    }
    writeFileSync(
      path.join(staging, CURSOR_DISABLED_FILE),
      `${JSON.stringify(disabled, null, 2)}\n`,
    );
    try {
      renameSync(staging, overlayProject);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(overlayProject)) throw error;
    }
  }
  return { CURSOR_DATA_DIR: overlayRoot };
}

/** The git top level Cursor keys its project data by, else the folder itself. */
function cursorProjectRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (root) return root;
  } catch {
    // Not a git checkout.
  }
  return path.resolve(cwd);
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
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
