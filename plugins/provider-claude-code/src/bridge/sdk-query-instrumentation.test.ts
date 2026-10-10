import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { projectSdkQueryInstrumentation } from "./sdk-query-instrumentation.js";

describe("projectSdkQueryInstrumentation", () => {
  it("projects settingSources, plugins, tools, and instruction digest without env or prompt", () => {
    const options = {
      settingSources: [],
      plugins: [{ type: "local", path: "/tmp/agency-skill" }],
      allowedTools: ["Read"],
      mcpServers: { bridge: {} },
      systemPrompt: "isolated",
      env: { HOME: "/should-not-appear", ANTHROPIC_API_KEY: "secret" },
      resume: "sess_1",
    } as Options;
    const projection = projectSdkQueryInstrumentation({
      options,
      isolatedSkillDelivery: true,
    });
    expect(projection.settingSources).toEqual([]);
    expect(projection.plugins).toEqual([
      { type: "local", name: null, path: "/tmp/agency-skill" },
    ]);
    expect(projection.toolNames).toEqual(["Read", "bridge"]);
    expect(projection.instruction).toEqual({
      length: 8,
      sha256: createHash("sha256").update("isolated").digest("hex"),
    });
    expect(projection.isolatedSkillDelivery).toBe(true);
    expect(projection.resume).toBe(true);
    expect(JSON.stringify(projection)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(projection)).not.toContain("/should-not-appear");
    expect(projection).not.toHaveProperty("env");
    expect(projection).not.toHaveProperty("prompt");
  });
});
