import { describe, expect, it } from "vitest";
import { buildSessionOptions } from "./session-options.js";

const base = {
  cwd: "/tmp/qa",
  instructionMode: "replace" as const,
  permissionMode: "acceptEdits" as const,
  permissionScope: "workspace" as const,
  workflowsEnabled: false,
  chromeEnabled: false,
};

describe("compiled main agent session options", () => {
  it("sets Options.agent and Options.agents without model or permissionMode", () => {
    const options = buildSessionOptions(
      {
        ...base,
        vkCompiledMainAgent: {
          id: "dev-orchestrator",
          sourceVersion: "lp-owned-1",
          sourceHash: "a".repeat(64),
          description: "Lane Pilot development orchestrator",
          prompt: "You are the Lane Pilot development orchestrator.",
        },
      },
      {},
    );
    expect(options.agent).toBe("dev-orchestrator");
    expect(options.agents?.["dev-orchestrator"]).toEqual({
      description: "Lane Pilot development orchestrator",
      prompt: "You are the Lane Pilot development orchestrator.",
    });
    expect(options.agents?.["dev-orchestrator"]).not.toHaveProperty("model");
    expect(options.agents?.["dev-orchestrator"]).not.toHaveProperty(
      "permissionMode",
    );
    expect(options.model).toBeUndefined();
  });

  it("keeps append systemPrompt separate from agent.prompt", () => {
    const options = buildSessionOptions(
      {
        ...base,
        instructionMode: "append",
        baseInstructions: "BB session instructions.",
        vkCompiledMainAgent: {
          id: "copy-lead",
          sourceVersion: "lp-owned-1",
          sourceHash: "b".repeat(64),
          description: "Lane Pilot copy lead",
          prompt: "You are the Lane Pilot copy lead.",
        },
      },
      {},
    );
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "BB session instructions.",
    });
    expect(options.agents?.["copy-lead"]?.prompt).toBe(
      "You are the Lane Pilot copy lead.",
    );
    expect(JSON.stringify(options.systemPrompt)).not.toContain(
      "You are the Lane Pilot copy lead.",
    );
  });

  it("intersects agent skills and MCP servers with the required session ceiling while preserving bb-bridge", () => {
    const options = buildSessionOptions(
      {
        ...base,
        vkSessionPolicy: {
          version: 1,
          required: true,
          skills: { mode: "allow", names: ["safe*"] },
          mcpServers: { mode: "allow", names: ["safe-mcp"] },
        },
        vkCompiledMainAgent: {
          id: "copy-lead",
          sourceVersion: "lp-owned-1",
          sourceHash: "a".repeat(64),
          description: "copy lead",
          prompt: "write",
          skills: ["safe-reader", "secret"],
          mcpServers: ["safe-mcp", "secret-mcp"],
        },
      },
      {},
    );
    expect(options.agents?.["copy-lead"]?.skills).toEqual(["safe-reader"]);
    expect(options.agents?.["copy-lead"]?.mcpServers).toEqual([
      "bb-bridge",
      "safe-mcp",
    ]);
  });

  it("does not start compiling an incomplete required profile", () => {
    expect(() =>
      buildSessionOptions(
        {
          ...base,
          vkCompiledMainAgent: {
            id: "",
            sourceVersion: "lp-owned-1",
            sourceHash: "a".repeat(64),
            description: "x",
            prompt: "y",
          },
        },
        {},
      ),
    ).toThrow(/vk_compiled_main_agent_incomplete/);
  });
});
