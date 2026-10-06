import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertPluginSchedule } from "@bb/db";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import {
  VK_DRAIN_DEFAULT_TIMEOUT_MS,
  VK_DRAIN_MAX_TIMEOUT_MS,
  createVkDrainGate,
  parseVkLifecycleDrain,
} from "../../../src/services/plugins/vk-plugin-drain.js";

interface Trace {
  events: Array<Record<string, unknown>>;
  hold?: Promise<void>;
  drainStarted?: () => void;
}
const trace = (): Trace =>
  (globalThis as unknown as { __vkDrain: Trace }).__vkDrain;

function serverSource(version: string, withHandler = true): string {
  return `
const t = (globalThis as any).__vkDrain;
${
  withHandler
    ? `export async function experimental_vkLifecycle(ctx: any) {
  t.events.push({ v: "${version}", action: ctx.action, deadline: typeof ctx.deadline, hasSignal: ctx.signal instanceof AbortSignal });
  if (ctx.action === "reload" || ctx.action === "shutdown") {
    t.drainStarted?.();
    if (t.hold) {
      ctx.signal.addEventListener("abort", () => t.events.push({ v: "${version}", aborted: true }));
      await t.hold;
    }
  }
}`
    : ""
}
export default function plugin(bb: any) {
  t.events.push({ v: "${version}", factory: true, startReason: bb.vk?.startReason, afterDrain: bb.vk?.afterDrain });
  bb.experimental_hooks.on("message.dispatch", async () => {
    t.events.push({ v: "${version}", hook: true });
    return { action: "proceed" };
  });
  bb.background.schedule("tick", "0 0 1 1 *", () => { t.events.push({ v: "${version}", schedule: true }); });
  bb.agents.registerTool({
    name: "drain_probe",
    description: "probe",
    parameters: { type: "object" },
    execute: () => { t.events.push({ v: "${version}", tool: true }); return "ok"; },
  });
  bb.background.service("watch", {
    start(signal: AbortSignal) {
      t.events.push({ v: "${version}", service: true, startReason: bb.vk?.startReason, afterDrain: bb.vk?.afterDrain });
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  });
  try {
    bb.hosts.experimental_client({ contract: { ping: {} } }).call("ping", {}, { hostId: "h1" }).catch((error: Error) => t.events.push({ v: "${version}", factoryHostCall: error.message }));
  } catch (error) {
    t.events.push({ v: "${version}", factoryHostCall: (error as Error).message });
  }
}
`;
}

function packageJson(drain: boolean): string {
  return JSON.stringify({
    name: "bb-plugin-drainer",
    version: "0.1.0",
    ...(drain ? { vk: { lifecycle: { drain: { timeoutMs: 5000 } } } } : {}),
    bb: {
      name: "Drainer",
      description: "VK drain fixture.",
      branding: { icon: "Zap" },
      server: "./server.ts",
    },
  });
}

describe("VK drain on reload and shutdown", () => {
  let harness: TestAppHarness;
  let rootDir: string;

  async function install(drain: boolean, withHandler = true): Promise<void> {
    (globalThis as unknown as { __vkDrain: Trace }).__vkDrain = { events: [] };
    rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-drainer");
    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "package.json"), packageJson(drain));
    await writeFile(join(rootDir, "server.ts"), serverSource("v1", withHandler));
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");
  }

  async function writeV2(withHandler = true): Promise<void> {
    await writeFile(join(rootDir, "server.ts"), serverSource("v2", withHandler));
  }

  const events = () => trace().events;
  const hookHandler = () => {
    const [registration] = harness.pluginService.hooks
      .listHooks("message.dispatch")
      .filter((entry) => entry.pluginId === "drainer");
    if (registration === undefined) throw new Error("hook is not registered");
    return registration.handler as unknown as (context: unknown) => Promise<unknown>;
  };

  beforeEach(async () => {
    harness = await createTestAppHarness();
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("runs the reload drain in the old instance, holds new work for the new one and tells it how it started", async () => {
    await install(true);
    expect(events().filter((event) => event.factory)).toEqual([
      { v: "v1", factory: true, startReason: "boot", afterDrain: false },
    ]);
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      trace().drainStarted = resolve;
    });
    trace().hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await writeV2();
    const reloading = harness.pluginService.reload("drainer");
    await started;

    // New work for the draining plugin does not reach the old instance.
    const dispatchCall = hookHandler()({});
    const toolRecord = harness.pluginService.findAgentTool("drain_probe");
    if (toolRecord === undefined) throw new Error("tool missing");
    const toolCall = harness.pluginService.invokeAgentTool({
      pluginId: "drainer",
      record: toolRecord.record,
      input: {},
      ctx: {} as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events().filter((event) => event.hook || event.tool)).toEqual([]);
    expect(events().filter((event) => event.v === "v2" && event.factory)).toEqual([
      { v: "v2", factory: true, startReason: "reload", afterDrain: false },
    ]);

    release();
    expect((await reloading).ok).toBe(true);
    await dispatchCall;
    await toolCall;
    expect(events().filter((event) => event.hook || event.tool)).toEqual([
      { v: "v2", hook: true },
      { v: "v2", tool: true },
    ]);
    expect(events()).toContainEqual({ v: "v1", action: "reload", deadline: "number", hasSignal: true });
    expect(events().filter((event) => event.service && event.v === "v2")).toEqual([
      { v: "v2", service: true, startReason: "reload", afterDrain: true },
    ]);
  });

  it("aborts a drain that overruns its deadline and reloads anyway", async () => {
    await install(true);
    await writeFile(join(rootDir, "package.json"), packageJson(true).replace("5000", "1000"));
    // The running instance keeps the manifest it loaded with: reload once to adopt 1000 ms.
    await harness.pluginService.reload("drainer");
    trace().hold = new Promise<void>(() => {});
    await writeV2();
    const startedAt = Date.now();
    const outcome = await harness.pluginService.reload("drainer");
    expect(outcome.ok).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(events()).toContainEqual({ v: "v1", aborted: true });
    expect(events().filter((event) => event.v === "v2" && event.service)).toEqual([
      { v: "v2", service: true, startReason: "reload", afterDrain: false },
    ]);
  });

  it("holds a due schedule while draining and keeps it due for the new instance", async () => {
    await install(true);
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      trace().drainStarted = resolve;
    });
    trace().hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await writeV2();
    const reloading = harness.pluginService.reload("drainer");
    await started;
    upsertPluginSchedule(harness.deps.db, { pluginId: "drainer", name: "tick", cron: "0 0 1 1 *", nextRunAt: 1 });
    await harness.pluginService.sweepDueSchedules(Date.now());
    expect(events().filter((event) => event.schedule)).toEqual([]);
    release();
    await reloading;
    await harness.pluginService.sweepDueSchedules(Date.now());
    expect(events().filter((event) => event.schedule)).toEqual([{ v: "v2", schedule: true }]);
  });

  it("runs the shutdown drain when the server stops the plugin", async () => {
    await install(true);
    await harness.pluginService.stop();
    expect(events()).toContainEqual({ v: "v1", action: "shutdown", deadline: "number", hasSignal: true });
  });

  it("reports a clear error for a host call made from the factory of a draining plugin", async () => {
    await install(true);
    const message = events().find((event) => event.factoryHostCall)?.factoryHostCall;
    expect(message).toContain("vk.lifecycle.drain");
    expect(message).toContain("background service");
  });

  it("reports startReason enable after the user switches the plugin back on", async () => {
    await install(true);
    await harness.pluginService.setEnabled("drainer", false);
    await harness.pluginService.setEnabled("drainer", true);
    expect(events().filter((event) => event.factory).map((event) => event.startReason)).toEqual(["boot", "enable"]);
  });

  it("stock: a plugin without vk.lifecycle.drain reloads without any drain, raw hook handlers and a plain host error", async () => {
    await install(false);
    const rawHandler = harness.pluginService.hooks
      .listHooks("message.dispatch")
      .find((entry) => entry.pluginId === "drainer")?.handler;
    expect(rawHandler).toBeDefined();
    expect(hookHandler()).toBe(rawHandler);
    await writeV2();
    expect((await harness.pluginService.reload("drainer")).ok).toBe(true);
    expect(events().filter((event) => event.action)).toEqual([{ v: "v1", action: "enable", deadline: "undefined", hasSignal: true }]);
    expect(events().find((event) => event.factoryHostCall)?.factoryHostCall).toContain("unavailable during factory registration");
    await harness.pluginService.stop();
    expect(events().filter((event) => event.action).map((event) => event.action)).toEqual(["enable"]);
  });

  it("a drain-declaring plugin without the export reloads normally", async () => {
    await install(true, false);
    await writeV2(false);
    expect((await harness.pluginService.reload("drainer")).ok).toBe(true);
    expect(events().filter((event) => event.v === "v2" && event.factory)).toHaveLength(1);
  });
});

describe("vk.lifecycle.drain manifest field", () => {
  const parse = (value: unknown) => {
    const warnings: string[] = [];
    return { declared: parseVkLifecycleDrain(value, (message) => warnings.push(message)), warnings };
  };

  it("is undeclared without the field", () => {
    expect(parse(undefined).declared).toBeUndefined();
    expect(parse({}).declared).toBeUndefined();
    expect(parse({ lifecycle: {} }).declared).toBeUndefined();
    expect(parse("x").declared).toBeUndefined();
  });

  it("defaults and clamps the timeout, warning instead of failing", () => {
    expect(parse({ lifecycle: { drain: {} } }).declared).toEqual({ timeoutMs: VK_DRAIN_DEFAULT_TIMEOUT_MS });
    expect(parse({ lifecycle: { drain: { timeoutMs: 45_000 } } }).declared).toEqual({ timeoutMs: 45_000 });
    const high = parse({ lifecycle: { drain: { timeoutMs: 9_999_999 } } });
    expect(high.declared).toEqual({ timeoutMs: VK_DRAIN_MAX_TIMEOUT_MS });
    expect(high.warnings).toHaveLength(1);
    expect(parse({ lifecycle: { drain: { timeoutMs: 5 } } }).declared).toEqual({ timeoutMs: 1_000 });
    const bad = parse({ lifecycle: { drain: { timeoutMs: "soon" } } });
    expect(bad.declared).toEqual({ timeoutMs: VK_DRAIN_DEFAULT_TIMEOUT_MS });
    expect(bad.warnings).toHaveLength(1);
    expect(parse({ lifecycle: { drain: true } }).declared).toBeUndefined();
  });
});

describe("drain gate", () => {
  it("opens at once when idle, on end, and by timeout", async () => {
    const gate = createVkDrainGate();
    expect(await gate.waitUpTo("p", 10)).toBe(true);
    gate.begin("p", 60_000);
    expect(gate.isDraining("p")).toBe(true);
    expect(await gate.waitUpTo("p", 20)).toBe(false);
    const waiting = gate.waitUpTo("p", 5_000);
    gate.end("p");
    expect(await waiting).toBe(true);
    expect(gate.isDraining("p")).toBe(false);
  });
});
