import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSdkQueryInstrumentationSink,
  projectSdkQueryInstrumentation,
  recordSdkQueryInstrumentation,
  sdkQueryRecordFile,
} from "./sdk-query-instrumentation.js";

vi.mock("@get-bb/plugin-sdk/provider-bridge", () => ({
  experimental_isProviderBridgeRecording: () =>
    process.env.BB_PROVIDER_BRIDGE_RECORD_DIR !== undefined &&
    process.env.BB_PROVIDER_BRIDGE_RECORD_DIR !== "",
}));

describe("projectSdkQueryInstrumentation", () => {
  it("projects settingSources, plugins, tools, and instruction digest without env or prompt", () => {
    const options = {
      settingSources: [],
      plugins: [{ type: "local", path: "/tmp/agency-skill" }],
      allowedTools: ["Read"],
      mcpServers: { bridge: { type: "sdk" as const, name: "bridge" } },
      systemPrompt: "isolated",
      resume: "sess_1",
      sessionId: "should-not-appear-as-query-session",
    };
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
    expect(projection.resumeSessionId).toBe("sess_1");
    expect(projection.querySessionId).toBeNull();
    expect(JSON.stringify(projection)).not.toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(projection)).not.toContain("/should-not-appear");
    expect(projection).not.toHaveProperty("env");
    expect(projection).not.toHaveProperty("prompt");
  });

  it("writes sdk-query next to the provider record scope, not a nested provider id", () => {
    expect(
      sdkQueryRecordFile("/tmp/record/claude-code", "thr_example"),
    ).toBe("/tmp/record/claude-code/thr_example/sdk-query.ndjson");
  });
});

describe("recordSdkQueryInstrumentation", () => {
  const previous = process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;
    } else {
      process.env.BB_PROVIDER_BRIDGE_RECORD_DIR = previous;
    }
  });

  it("notifies an explicit sink even when file recording is off", () => {
    delete process.env.BB_PROVIDER_BRIDGE_RECORD_DIR;
    const seen: unknown[] = [];
    const stop = addSdkQueryInstrumentationSink((row) => {
      seen.push(row);
    });
    recordSdkQueryInstrumentation({
      projection: projectSdkQueryInstrumentation({
        options: { settingSources: [], systemPrompt: "isolated" },
        isolatedSkillDelivery: true,
      }),
      threadId: "thr_sink",
    });
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "sdk-query",
      threadId: "thr_sink",
      settingSources: [],
      isolatedSkillDelivery: true,
    });
  });

  it("writes the opt-in file under the existing RECORD_DIR scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy16-sdk-query-"));
    process.env.BB_PROVIDER_BRIDGE_RECORD_DIR = dir;
    try {
      recordSdkQueryInstrumentation({
        projection: projectSdkQueryInstrumentation({
          options: {
            settingSources: [],
            plugins: [{ type: "local", path: "/tmp/agency" }],
            systemPrompt: "isolated",
          },
          isolatedSkillDelivery: true,
        }),
        threadId: "thr_file",
      });
      const file = join(dir, "thr_file", "sdk-query.ndjson");
      expect(readFileSync(file, "utf8")).toContain('"kind":"sdk-query"');
      expect(file).not.toContain("/claude-code/claude-code/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
