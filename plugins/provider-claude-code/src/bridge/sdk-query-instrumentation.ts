import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { experimental_isProviderBridgeRecording } from "@get-bb/plugin-sdk/provider-bridge";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export interface SdkQueryPluginProjection {
  type: string | null;
  name: string | null;
  path: string | null;
}

export interface SdkQueryInstructionProjection {
  length: number;
  sha256: string;
}

export interface SdkQueryInstrumentationProjection {
  settingSources: readonly string[];
  plugins: readonly SdkQueryPluginProjection[];
  toolNames: readonly string[];
  instruction: SdkQueryInstructionProjection;
  isolatedSkillDelivery: boolean;
  resume: boolean;
}

function instructionText(systemPrompt: Options["systemPrompt"]): string {
  if (typeof systemPrompt === "string") {
    return systemPrompt;
  }
  if (systemPrompt === undefined) {
    return "";
  }
  return JSON.stringify(systemPrompt);
}

function projectPlugin(value: unknown): SdkQueryPluginProjection {
  if (value === null || typeof value !== "object") {
    return { type: null, name: null, path: null };
  }
  const record = value as Record<string, unknown>;
  return {
    type: typeof record.type === "string" ? record.type : null,
    name: typeof record.name === "string" ? record.name : null,
    path: typeof record.path === "string" ? record.path : null,
  };
}

export function projectSdkQueryInstrumentation(args: {
  options: Options;
  isolatedSkillDelivery: boolean;
}): SdkQueryInstrumentationProjection {
  const settingSources = Array.isArray(args.options.settingSources)
    ? args.options.settingSources.filter(
        (source): source is string => typeof source === "string",
      )
    : [];
  const plugins = Array.isArray(args.options.plugins)
    ? args.options.plugins.map(projectPlugin)
    : [];
  const toolNames = [
    ...(Array.isArray(args.options.allowedTools)
      ? args.options.allowedTools.filter(
          (name): name is string => typeof name === "string",
        )
      : []),
    ...(args.options.mcpServers !== undefined
      ? Object.keys(args.options.mcpServers)
      : []),
  ];
  const text = instructionText(args.options.systemPrompt);
  return {
    settingSources,
    plugins,
    toolNames,
    instruction: {
      length: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
    },
    isolatedSkillDelivery: args.isolatedSkillDelivery,
    resume: typeof args.options.resume === "string" && args.options.resume.length > 0,
  };
}

export function recordSdkQueryInstrumentation(args: {
  projection: SdkQueryInstrumentationProjection;
  threadId: string | null;
}): void {
  if (!experimental_isProviderBridgeRecording()) {
    return;
  }
  const dir = process.env.BB_PROVIDER_BRIDGE_RECORD_DIR?.trim();
  if (dir === undefined || dir === "") {
    return;
  }
  const scope =
    args.threadId !== null && args.threadId !== ""
      ? args.threadId.replace(/[^A-Za-z0-9_.-]+/g, "-")
      : "_process";
  const file = join(dir, "claude-code", scope, "sdk-query.ndjson");
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({
      ts: Date.now(),
      kind: "sdk-query",
      threadId: args.threadId,
      ...args.projection,
    })}\n`,
    "utf8",
  );
}
