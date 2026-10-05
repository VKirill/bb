import { describe, expect, it } from "vitest";
import { buildSessionOptions } from "./session-options.js";

const base = {
  cwd: "/tmp/qa",
  instructionMode: "replace" as const,
  permissionMode: "acceptEdits" as const,
  permissionScope: "workspace" as const,
  workflowsEnabled: false,
  serviceTier: "default" as const,
  disable1MContext: false,
  sandboxEnabled: false,
  chromeEnabled: false,
};

describe("compiled main agent session options", () => {
  it("keeps the full compiled native tool list and exposes exact BB bridge tools", () => {
    const nativeTools = [
      "Agent(lane-stack:run-supervisor, lane-stack:lane-supervisor, lane-stack:emergency-writer, lane-stack:night-reviewer, lane-stack:project-onboarder, lane-stack:docs-maintainer, lane-stack:design-lead, lane-stack:seo-specialist, lane-stack:copy-lead, lane-stack:tavily, lane-stack:browser-qa, Explore, Plan, general-purpose)",
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "TaskStop",
      "SendMessage",
      "ListAgents",
      "mcp__agentmemory__memory_recall",
      "mcp__agentmemory__memory_smart_search",
      "mcp__agentmemory__memory_profile",
      "mcp__agentmemory__memory_sessions",
      "mcp__agentmemory__memory_remember",
      "mcp__gitnexus__query",
      "mcp__gitnexus__context",
      "mcp__gitnexus__impact",
      "mcp__gitnexus__detect_changes",
      "mcp__gitnexus__list_repos",
      "mcp__metamcp__mcp_discover",
      "mcp__metamcp__mcp_call",
      "mcp__metamcp__mcp_execute",
      "mcp__metamcp__mcp_provision",
    ];
    const bridgeTools = [
      "mcp__bb-bridge__lane_pilot_read",
      "mcp__bb-bridge__bb_workflow_run",
    ];
    const options = buildSessionOptions(
      {
        ...base,
        bridgeToolNames: bridgeTools,
        vkCompiledMainAgent: {
          id: "dev-orchestrator",
          sourceVersion: "lp-owned-1",
          sourceHash: "a".repeat(64),
          description: "Lane Pilot development orchestrator",
          prompt: "Full compiled profile prompt.",
          tools: nativeTools,
          mcpServers: ["metamcp"],
        },
      },
      {},
    );

    expect(options.tools).toEqual(nativeTools);
    expect(options.agent).toBe("dev-orchestrator");
    expect(options.agents?.["dev-orchestrator"]?.tools).toEqual([
      ...nativeTools,
      ...bridgeTools,
    ]);
    expect(options.agents?.["dev-orchestrator"]?.mcpServers).toEqual([
      "bb-bridge",
      "metamcp",
    ]);
    expect(options.agents?.["dev-orchestrator"]?.tools).not.toContain("*");
  });

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
