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
  /** SDK `resume` session id, or null when this query starts a new session. */
  resumeSessionId: string | null;
  /** SDK `sessionId` for a new query, or null when resuming. */
  querySessionId: string | null;
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
  options: {
    settingSources?: readonly unknown[];
    plugins?: readonly unknown[];
    allowedTools?: readonly string[];
    mcpServers?: Record<string, unknown>;
    systemPrompt?: Options["systemPrompt"];
    resume?: unknown;
    sessionId?: unknown;
  };
  isolatedSkillDelivery: boolean;
}): SdkQueryInstrumentationProjection {
  const settingSources = Array.isArray(args.options.settingSources)
    ? args.options.settingSources.map((source) => String(source))
    : [];
  const plugins = Array.isArray(args.options.plugins)
    ? args.options.plugins.map(projectPlugin)
    : [];
  const toolNames = [
    ...(Array.isArray(args.options.allowedTools)
      ? args.options.allowedTools.filter((name) => typeof name === "string")
      : []),
    ...(args.options.mcpServers !== undefined
      ? Object.keys(args.options.mcpServers)
      : []),
  ];
  const text = instructionText(args.options.systemPrompt);
  const resumeSessionId =
    typeof args.options.resume === "string" && args.options.resume.length > 0
      ? args.options.resume
      : null;
  const querySessionId =
    resumeSessionId === null &&
    typeof args.options.sessionId === "string" &&
    args.options.sessionId.length > 0
      ? args.options.sessionId
      : null;
  return {
    settingSources,
    plugins,
    toolNames,
    instruction: {
      length: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
    },
    isolatedSkillDelivery: args.isolatedSkillDelivery,
    resume: resumeSessionId !== null,
    resumeSessionId,
    querySessionId,
  };
}

export interface SdkQueryInstrumentationRecord {
  ts: number;
  kind: "sdk-query";
  threadId: string | null;
  settingSources: readonly string[];
  plugins: readonly SdkQueryPluginProjection[];
  toolNames: readonly string[];
  instruction: SdkQueryInstructionProjection;
  isolatedSkillDelivery: boolean;
  resume: boolean;
  resumeSessionId: string | null;
  querySessionId: string | null;
}

export type SdkQueryInstrumentationSink = (
  record: SdkQueryInstrumentationRecord,
) => void;

const sinks = new Set<SdkQueryInstrumentationSink>();

/** Test / explicit opt-in sink. Production does not register one. */
export function addSdkQueryInstrumentationSink(
  sink: SdkQueryInstrumentationSink,
): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

export function sdkQueryRecordScope(threadId: string | null): string {
  if (threadId !== null && threadId !== "") {
    const sanitized = threadId.replace(/[^A-Za-z0-9_.-]+/g, "-");
    return sanitized === "" ? "_process" : sanitized;
  }
  return "_process";
}

/** RECORD_DIR already includes the provider id from the runtime spawn. */
export function sdkQueryRecordFile(
  recordDir: string,
  threadId: string | null,
): string {
  return join(recordDir, sdkQueryRecordScope(threadId), "sdk-query.ndjson");
}

function toRecord(args: {
  projection: SdkQueryInstrumentationProjection;
  threadId: string | null;
}): SdkQueryInstrumentationRecord {
  return {
    ts: Date.now(),
    kind: "sdk-query",
    threadId: args.threadId,
    ...args.projection,
  };
}

export function recordSdkQueryInstrumentation(args: {
  projection: SdkQueryInstrumentationProjection;
  threadId: string | null;
}): void {
  const record = toRecord(args);
  for (const sink of sinks) {
    sink(record);
  }
  if (!experimental_isProviderBridgeRecording()) {
    return;
  }
  const dir = process.env.BB_PROVIDER_BRIDGE_RECORD_DIR?.trim();
  if (dir === undefined || dir === "") {
    return;
  }
  const file = sdkQueryRecordFile(dir, args.threadId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}
