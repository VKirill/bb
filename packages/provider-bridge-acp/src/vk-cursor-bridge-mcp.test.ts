import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  vkCursorBridgeMcpInstructions,
  vkCursorLaunchArgs,
  vkCursorSafeMcpInputSchema,
  vkInstallCursorBridgeMcp,
  vkRevokeCursorBridgeMcp,
} from "./vk-cursor-bridge-mcp.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function mcpConfig(threadId: string) {
  return {
    name: "bb-bridge" as const,
    command: "/usr/local/bin/node",
    args: ["/app/bridge.js", "--mcp-stdio"],
    env: [
      { name: "BB_ACP_DYNAMIC_TOOL_THREAD_ID", value: threadId },
      { name: "BB_TOKEN", value: "secret" },
    ],
  };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("VK Cursor bridge MCP", () => {
  it("adds --approve-mcps for cursor-agent and leaves other agents alone", () => {
    expect(vkCursorLaunchArgs("cursor-agent", ["acp"])).toEqual([
      "--approve-mcps",
      "acp",
    ]);
    expect(
      vkCursorLaunchArgs("cursor-agent", ["--approve-mcps", "acp"]),
    ).toEqual(["--approve-mcps", "acp"]);
    expect(vkCursorLaunchArgs("cursor-agent", ["/tmp/fake-acp-agent.mjs"])).toEqual(
      ["/tmp/fake-acp-agent.mjs"],
    );
    expect(vkCursorLaunchArgs("opencode", ["acp"])).toEqual(["acp"]);
  });

  it("names the bb-bridge MCP namespace in the Cursor instructions", () => {
    expect(vkCursorBridgeMcpInstructions()).toContain('namespace "bb-bridge"');
    expect(vkCursorBridgeMcpInstructions()).toContain("CallDynamicTool");
  });

  it("adds type object so Cursor does not drop oneOf tool schemas", () => {
    expect(
      vkCursorSafeMcpInputSchema({
        oneOf: [{ type: "object", properties: { hostId: { type: "string" } } }],
      }),
    ).toMatchObject({ type: "object" });
    const already = {
      type: "object",
      properties: { prompt: { type: "string" } },
    };
    expect(vkCursorSafeMcpInputSchema(already)).toBe(already);
  });

  it("does not touch MCP config for other ACP agents", async () => {
    const home = makeTempDir("vk-cursor-home-");
    await expect(
      vkInstallCursorBridgeMcp({
        agentCommand: "opencode",
        config: mcpConfig("thr_a"),
        env: { HOME: home },
        threadId: "thr_a",
      }),
    ).resolves.toBeUndefined();
    expect(() => readFileSync(join(home, ".cursor", "mcp.json"))).toThrow();
  });

  it("writes bb-bridge into the user mcp.json before restore", async () => {
    const home = makeTempDir("vk-cursor-home-");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { gitnexus: { command: "gitnexus" } } }),
    );
    const install = await vkInstallCursorBridgeMcp({
      agentCommand: "/opt/cursor/cursor-agent",
      config: mcpConfig("thr_a"),
      env: { HOME: home },
      threadId: "thr_a",
    });
    if (!install) {
      throw new Error("expected install");
    }
    const written = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(written.mcpServers.gitnexus).toEqual({ command: "gitnexus" });
    expect(written.mcpServers["bb-bridge"]?.env?.BB_ACP_DYNAMIC_TOOL_THREAD_ID).toBe(
      "thr_a",
    );

    await vkRevokeCursorBridgeMcp(install);
    expect(
      JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")),
    ).toEqual({ mcpServers: { gitnexus: { command: "gitnexus" } } });
  });

  it("does not restore over a later thread's bb-bridge entry", async () => {
    const home = makeTempDir("vk-cursor-home-");
    const env = { HOME: home };
    const first = await vkInstallCursorBridgeMcp({
      agentCommand: "cursor-agent",
      config: mcpConfig("thr_a"),
      env,
      threadId: "thr_a",
    });
    const second = await vkInstallCursorBridgeMcp({
      agentCommand: "cursor-agent",
      config: mcpConfig("thr_b"),
      env,
      threadId: "thr_b",
    });
    if (!first || !second) {
      throw new Error("expected installs");
    }
    await vkRevokeCursorBridgeMcp(first);
    const leftover = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    expect(
      leftover.mcpServers["bb-bridge"]?.env?.BB_ACP_DYNAMIC_TOOL_THREAD_ID,
    ).toBe("thr_b");
    await vkRevokeCursorBridgeMcp(second);
  });

  it("also writes overlay mcp.json when CURSOR_DATA_DIR is set", async () => {
    const home = makeTempDir("vk-cursor-home-");
    const overlay = makeTempDir("vk-cursor-overlay-");
    const install = await vkInstallCursorBridgeMcp({
      agentCommand: "cursor-agent",
      config: mcpConfig("thr_a"),
      env: { HOME: home, CURSOR_DATA_DIR: overlay },
      threadId: "thr_a",
    });
    if (!install) {
      throw new Error("expected install");
    }
    expect(install.overlayMcpPath).toBe(join(overlay, "mcp.json"));
    const overlayDoc = JSON.parse(
      readFileSync(join(overlay, "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    expect(overlayDoc.mcpServers["bb-bridge"]).toBeTruthy();
    await vkRevokeCursorBridgeMcp(install);
    expect(
      JSON.parse(readFileSync(join(overlay, "mcp.json"), "utf8")),
    ).toEqual({});
  });
});
