import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  ACP_BRIDGE_MCP_SERVER_NAME,
  type AcpMcpServerConfig,
} from "./bridge/tool-proxy-mcp.js";
/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Cursor ACP does not put session/new MCP tools into the model's native
 * function list. Grok discovers MCP from ~/.cursor/mcp.json (GetDynamicTools).
 * This writes bb-bridge there before cursor-agent starts, and restores it
 * when the BB thread stops.
 */

const BB_BRIDGE_THREAD_ENV = "BB_ACP_DYNAMIC_TOOL_THREAD_ID";
const USER_MCP_FILE = "mcp.json";
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;

export interface VkCursorBridgeMcpInstall {
  mcpJsonPath: string;
  overlayMcpPath: string | undefined;
  previous: unknown;
  threadId: string;
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function isCursorAgentCommand(command: string): boolean {
  return (
    basename(command)
      .toLowerCase()
      .replace(/\.(?:bat|cmd|exe)$/u, "") === "cursor-agent"
  );
}

function homeDirectory(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

function userMcpPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(homeDirectory(env), ".cursor", USER_MCP_FILE);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mcpServersOf(doc: Record<string, unknown>): Record<string, unknown> {
  return asObject(doc.mcpServers);
}

function threadIdFromServer(value: unknown): string | undefined {
  const env = asObject(asObject(value).env);
  const id = env[BB_BRIDGE_THREAD_ENV];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function vkCursorBridgeMcpInstructions(): string {
  return [
    "BB plugin tools (for example image_studio_generate, env_get, bb_file_gateway, update_environment_directory) are in the MCP namespace \"bb-bridge\", not in Cursor's built-in function list.",
    "Call GetDynamicTools with namespace \"bb-bridge\" (or toolName for one tool), then CallDynamicTool with namespace \"bb-bridge\" and that tool name.",
    "Do not run bb image-studio generate or other plugin CLIs in a visible chat when those tools exist — that skips the in-chat picker.",
  ].join(" ");
}

export function vkCursorLaunchArgs(command: string, args: string[]): string[] {
  if (
    !isCursorAgentCommand(command) ||
    args.includes("--approve-mcps") ||
    !args.includes("acp")
  ) {
    return args;
  }
  return ["--approve-mcps", ...args];
}

function stdioServer(config: AcpMcpServerConfig): Record<string, unknown> {
  return {
    command: config.command,
    args: [...config.args],
    env: Object.fromEntries(
      config.env.map(({ name, value }) => [name, value]),
    ),
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {};
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(text);
  return asObject(parsed);
}

async function writeJsonObject(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.bb-vk-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.bb-vk-lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out updating Cursor MCP config: ${path}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

function putBridgeServer(
  doc: Record<string, unknown>,
  server: Record<string, unknown>,
): Record<string, unknown> {
  const servers = mcpServersOf(doc);
  return {
    ...doc,
    mcpServers: {
      ...servers,
      [ACP_BRIDGE_MCP_SERVER_NAME]: server,
    },
  };
}

function restoreBridgeServer(
  doc: Record<string, unknown>,
  previous: unknown,
): Record<string, unknown> {
  const servers = { ...mcpServersOf(doc) };
  if (previous === undefined) {
    delete servers[ACP_BRIDGE_MCP_SERVER_NAME];
  } else {
    servers[ACP_BRIDGE_MCP_SERVER_NAME] = previous as Record<string, unknown>;
  }
  const next = { ...doc, mcpServers: servers };
  if (Object.keys(servers).length === 0) {
    delete next.mcpServers;
  }
  return next;
}

export async function vkInstallCursorBridgeMcp(args: {
  agentCommand: string;
  config: AcpMcpServerConfig;
  env: Readonly<Record<string, string | undefined>>;
  threadId: string;
}): Promise<VkCursorBridgeMcpInstall | undefined> {
  if (
    !isCursorAgentCommand(args.agentCommand) ||
    args.config.name !== ACP_BRIDGE_MCP_SERVER_NAME
  ) {
    return undefined;
  }
  const server = stdioServer(args.config);
  const mcpJsonPath = userMcpPath(args.env);
  const overlayDir = args.env.CURSOR_DATA_DIR?.trim();
  const overlayMcpPath =
    overlayDir && overlayDir.length > 0
      ? join(overlayDir, USER_MCP_FILE)
      : undefined;

  let previous: unknown = undefined;
  const releaseLock = await acquireLock(mcpJsonPath);
  try {
    const doc = await readJsonObject(mcpJsonPath);
    previous = mcpServersOf(doc)[ACP_BRIDGE_MCP_SERVER_NAME];
    await writeJsonObject(mcpJsonPath, putBridgeServer(doc, server));
  } finally {
    await releaseLock();
  }

  if (overlayMcpPath && overlayMcpPath !== mcpJsonPath) {
    const overlayDoc = await readJsonObject(overlayMcpPath);
    await writeJsonObject(overlayMcpPath, putBridgeServer(overlayDoc, server));
  }

  return {
    mcpJsonPath,
    overlayMcpPath:
      overlayMcpPath && overlayMcpPath !== mcpJsonPath
        ? overlayMcpPath
        : undefined,
    previous,
    threadId: args.threadId,
  };
}

export async function vkRevokeCursorBridgeMcp(
  install: VkCursorBridgeMcpInstall,
): Promise<void> {
  const releaseLock = await acquireLock(install.mcpJsonPath);
  try {
    const doc = await readJsonObject(install.mcpJsonPath);
    const current = mcpServersOf(doc)[ACP_BRIDGE_MCP_SERVER_NAME];
    if (threadIdFromServer(current) === install.threadId) {
      await writeJsonObject(
        install.mcpJsonPath,
        restoreBridgeServer(doc, install.previous),
      );
    }
  } finally {
    await releaseLock();
  }

  if (!install.overlayMcpPath) {
    return;
  }
  const overlayDoc = await readJsonObject(install.overlayMcpPath);
  const overlayCurrent = mcpServersOf(overlayDoc)[ACP_BRIDGE_MCP_SERVER_NAME];
  if (threadIdFromServer(overlayCurrent) !== install.threadId) {
    return;
  }
  await writeJsonObject(
    install.overlayMcpPath,
    restoreBridgeServer(overlayDoc, undefined),
  );
}
