import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  listPluginSchedules,
  migrate,
  pluginSchedules,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  VK_SCHEDULE_MAX_TIMEOUT_MS,
  vkParseScheduleManifest,
} from "../../../src/services/plugins/vk-schedule-options.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

// VK EXPERIMENTAL: isolated plugin schedules (experimental_vkSchedule and the
// package.json `vk.schedules` manifest field) through the plugin service.

const logger = testLogger as unknown as Logger;

interface Control {
  started: string[];
  signals: Record<string, AbortSignal | undefined>;
  gates: Map<string, () => void>;
  wait(name: string): Promise<void>;
  release(name: string): void;
}

const globals = globalThis as Record<string, unknown>;

function control(): Control {
  const state: Control = {
    started: [],
    signals: {},
    gates: new Map(),
    wait(name) {
      state.started.push(name);
      return new Promise<void>((resolve) => {
        state.gates.set(name, resolve);
      });
    },
    release(name) {
      state.gates.get(name)?.();
      state.gates.delete(name);
    },
  };
  return state;
}

async function writePlugin(
  dir: string,
  name: string,
  serverSource: string,
  vk?: unknown,
): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      bb: {
        name: "VK schedule fixture",
        description: "Schedule options plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
      ...(vk === undefined ? {} : { vk }),
    }),
  );
  await writeFile(join(rootDir, "server.ts"), serverSource);
  return rootDir;
}

function setNextRunAt(
  db: DbConnection,
  pluginId: string,
  name: string,
  nextRunAt: number,
): void {
  db.update(pluginSchedules)
    .set({ nextRunAt })
    .where(
      and(
        eq(pluginSchedules.pluginId, pluginId),
        eq(pluginSchedules.name, name),
      ),
    )
    .run();
}

function row(db: DbConnection, pluginId: string, name: string) {
  const found = listPluginSchedules(db, pluginId).find((r) => r.name === name);
  if (found === undefined) throw new Error(`no schedule ${pluginId}/${name}`);
  return found;
}

describe("vk schedule manifest parser", () => {
  it("returns nothing without vk.schedules", () => {
    expect(vkParseScheduleManifest({ name: "x" })).toBeUndefined();
    expect(vkParseScheduleManifest({ vk: { hookPolicy: {} } })).toBeUndefined();
    expect(vkParseScheduleManifest(null)).toBeUndefined();
  });

  it("keeps valid fields, drops invalid ones with a warning, clamps the timeout", () => {
    const parsed = vkParseScheduleManifest({
      vk: {
        schedules: {
          ok: { isolated: true, timeoutMs: 1500.7, overlap: "skip" },
          bad: { isolated: "yes", timeoutMs: -5, overlap: "queue", extra: 1 },
          huge: { isolated: true, timeoutMs: VK_SCHEDULE_MAX_TIMEOUT_MS * 2 },
          notObject: 7,
        },
      },
    });
    expect(parsed?.options.get("ok")).toEqual({
      isolated: true,
      timeoutMs: 1500,
      overlap: "skip",
    });
    expect(parsed?.options.get("bad")).toEqual({});
    expect(parsed?.options.get("huge")).toEqual({
      isolated: true,
      timeoutMs: VK_SCHEDULE_MAX_TIMEOUT_MS,
    });
    expect(parsed?.options.get("notObject")).toEqual({});
    expect(parsed?.warnings.length).toBeGreaterThanOrEqual(6);
  });

  it("ignores a vk.schedules that is not an object", () => {
    const parsed = vkParseScheduleManifest({ vk: { schedules: [1] } });
    expect(parsed?.options.size).toBe(0);
    expect(parsed?.warnings).toHaveLength(1);
  });
});

describe("vk isolated schedules", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;
  let ctl: Control;

  beforeEach(async () => {
    ctl = control();
    globals.__vk = ctl;
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-vk-sched-test-"));
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      serviceStopTimeoutMs: 100,
    });
  });

  afterEach(async () => {
    for (const name of [...ctl.gates.keys()]) ctl.release(name);
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
    delete globals.__vk;
  });

  async function install(
    name: string,
    serverSource: string,
    vk?: unknown,
  ): Promise<void> {
    await service.installPath(
      await writePlugin(workDir, `bb-plugin-${name}`, serverSource, vk),
    );
  }

  function makeDue(pluginId: string, name: string, ageMs = 60_000): void {
    setNextRunAt(db, pluginId, name, Date.now() - ageMs);
  }

  it("a hung isolated schedule does not hold other plugins' schedules, now or later", async () => {
    await install(
      "slowiso",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.experimental_vkSchedule("a", "*/5 * * * *",
          () => g.__vk.wait("a"), { isolated: true });
      }`,
    );
    await install(
      "plainb",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.schedule("b", "*/5 * * * *", async () => { g.__vk.started.push("b"); });
      }`,
    );
    await install(
      "isoc",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.schedule("c", "*/5 * * * *", async () => { g.__vk.started.push("c"); });
      }`,
      { schedules: { c: { isolated: true } } },
    );

    makeDue("slowiso", "a", 180_000);
    makeDue("plainb", "b", 120_000);
    makeDue("isoc", "c", 60_000);
    await service.sweepDueSchedules(Date.now());
    // A is still hanging ("10 minutes"), the sweep itself finished.
    expect(ctl.started).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(row(db, "slowiso", "a").lastStatus).toBe("running");
    expect(row(db, "plainb", "b").lastStatus).toBe("ok");
    await vi.waitFor(() => expect(row(db, "isoc", "c").lastStatus).toBe("ok"));

    // A later sweep: B and C run again on time, A is not started a second time.
    const aNext = row(db, "slowiso", "a").nextRunAt;
    makeDue("slowiso", "a");
    makeDue("plainb", "b");
    makeDue("isoc", "c");
    await service.sweepDueSchedules(Date.now());
    await vi.waitFor(() =>
      expect(ctl.started.filter((s) => s === "b")).toHaveLength(2),
    );
    await vi.waitFor(() =>
      expect(ctl.started.filter((s) => s === "c")).toHaveLength(2),
    );
    expect(ctl.started.filter((s) => s === "a")).toHaveLength(1);
    const skipped = row(db, "slowiso", "a");
    expect(skipped.nextRunAt).toBeGreaterThan(Date.now());
    expect(skipped.nextRunAt).toBeGreaterThanOrEqual(aNext);
    expect(skipped.lastStatus).toBe("running");

    // The run ends: status ok; the next due tick starts it again.
    ctl.release("a");
    await vi.waitFor(() =>
      expect(row(db, "slowiso", "a").lastStatus).toBe("ok"),
    );
    makeDue("slowiso", "a");
    await service.sweepDueSchedules(Date.now());
    expect(ctl.started.filter((s) => s === "a")).toHaveLength(2);
  });

  it("starts at most 8 isolated runs at once and skips the tick beyond that", async () => {
    const names = Array.from({ length: 9 }, (_, index) => `s${index}`);
    await install(
      "many",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        for (let i = 0; i < 9; i += 1) {
          bb.background.schedule("s" + i, "*/5 * * * *", () => g.__vk.wait("s" + i));
        }
      }`,
      {
        schedules: Object.fromEntries(
          names.map((name) => [name, { isolated: true }]),
        ),
      },
    );
    for (const name of names) makeDue("many", name);
    const before = Date.now();
    await service.sweepDueSchedules(before);
    expect(ctl.started).toHaveLength(8);
    const skippedName = names.find((name) => !ctl.started.includes(name));
    expect(skippedName).toBeDefined();
    const skipped = row(db, "many", skippedName as string);
    expect(skipped.lastStatus).toBeNull();
    expect(skipped.nextRunAt).toBeGreaterThan(before);

    // A slot frees up: the skipped schedule runs on its next due tick.
    ctl.release(ctl.started[0] as string);
    await vi.waitFor(() =>
      expect(row(db, "many", ctl.started[0] as string).lastStatus).toBe("ok"),
    );
    makeDue("many", skippedName as string);
    await service.sweepDueSchedules(Date.now());
    expect(ctl.started).toHaveLength(9);
  });

  it("aborts a run on timeout and records the timeout", async () => {
    await install(
      "timeouter",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.experimental_vkSchedule("t", "*/5 * * * *", ({ signal }: any) => {
          g.__vk.signals.t = signal;
          return new Promise<void>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        }, { isolated: true, timeoutMs: 40 });
      }`,
    );
    makeDue("timeouter", "t");
    await service.sweepDueSchedules(Date.now());
    expect(ctl.signals.t?.aborted).toBe(false);
    await vi.waitFor(() =>
      expect(row(db, "timeouter", "t").lastStatus).toBe("error"),
    );
    const timedOut = row(db, "timeouter", "t");
    expect(timedOut.lastError).toBe("timeout after 40ms");
    expect(ctl.signals.t?.aborted).toBe(true);
    // The settled run frees its slot: the next due tick starts it again.
    await vi.waitFor(async () => {
      makeDue("timeouter", "t");
      await service.sweepDueSchedules(Date.now());
      expect(row(db, "timeouter", "t").lastStatus).toBe("running");
    });
  });

  it("records a failing isolated run as an error without leaking a rejection", async () => {
    await install(
      "boomer",
      `export default function plugin(bb: any) {
        bb.background.experimental_vkSchedule("boom", "*/5 * * * *", async () => {
          throw new Error("isolated exploded");
        }, { isolated: true });
      }`,
    );
    makeDue("boomer", "boom");
    await service.sweepDueSchedules(Date.now());
    await vi.waitFor(() =>
      expect(row(db, "boomer", "boom").lastStatus).toBe("error"),
    );
    expect(row(db, "boomer", "boom").lastError).toContain("isolated exploded");
  });

  it("keeps stock behaviour for plugins that did not opt in: the sweep awaits each schedule in order", async () => {
    await install(
      "stockslow",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.schedule("a", "*/5 * * * *", () => g.__vk.wait("a"));
        bb.background.schedule("b", "*/5 * * * *", async () => { g.__vk.started.push("b"); });
      }`,
    );
    makeDue("stockslow", "a", 120_000);
    makeDue("stockslow", "b", 60_000);
    let sweepDone = false;
    const sweep = service
      .sweepDueSchedules(Date.now())
      .then(() => {
        sweepDone = true;
      });
    await vi.waitFor(() => expect(ctl.started).toEqual(["a"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sweepDone).toBe(false);
    expect(ctl.started).toEqual(["a"]);
    expect(row(db, "stockslow", "b").lastStatus).toBeNull();
    ctl.release("a");
    await sweep;
    expect(ctl.started).toEqual(["a", "b"]);
    expect(row(db, "stockslow", "a").lastStatus).toBe("ok");
    expect(row(db, "stockslow", "b").lastStatus).toBe("ok");
  });

  it("a stock manifest carries no vk property", async () => {
    const dir = await writePlugin(workDir, "bb-plugin-stockmanifest", "");
    expect("vkSchedules" in (await readPluginManifest(dir))).toBe(false);
  });

  it("applies the manifest option to a plain schedule and hands it a signal", async () => {
    await install(
      "manifested",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.schedule("m", "*/5 * * * *", (context: any) => {
          g.__vk.signals.m = context?.signal;
          return g.__vk.wait("m");
        });
      }`,
      { schedules: { m: { isolated: true } } },
    );
    makeDue("manifested", "m");
    await service.sweepDueSchedules(Date.now());
    expect(ctl.started).toEqual(["m"]);
    expect(row(db, "manifested", "m").lastStatus).toBe("running");
    expect(ctl.signals.m).toBeInstanceOf(AbortSignal);
  });

  it("ignores an invalid manifest entry without failing the plugin load", async () => {
    await install(
      "lenient",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.schedule("l", "*/5 * * * *", () => g.__vk.wait("l"));
      }`,
      { schedules: { l: { isolated: "yes", timeoutMs: "soon" } }, hookPolicy: 1 },
    );
    expect(service.list().find((p) => p.id === "lenient")?.status).toBe(
      "running",
    );
    makeDue("lenient", "l");
    let done = false;
    const sweep = service.sweepDueSchedules(Date.now()).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(ctl.started).toEqual(["l"]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false); // plain: the sweep still waits for it
    ctl.release("l");
    await sweep;
  });

  it("API options win over the manifest", async () => {
    await install(
      "apiwins",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.experimental_vkSchedule("off", "*/5 * * * *",
          async () => { g.__vk.started.push("off"); }, { isolated: false });
        bb.background.experimental_vkSchedule("long", "*/5 * * * *",
          () => g.__vk.wait("long"), { isolated: true, timeoutMs: 60_000 });
      }`,
      {
        schedules: {
          off: { isolated: true },
          long: { isolated: true, timeoutMs: 20 },
        },
      },
    );
    makeDue("apiwins", "off", 120_000);
    makeDue("apiwins", "long", 60_000);
    await service.sweepDueSchedules(Date.now());
    // "off": isolated:false in the API beats the manifest, so it ran in the sweep.
    expect(row(db, "apiwins", "off").lastStatus).toBe("ok");
    // "long": the API timeout (60 s) beats the manifest's 20 ms.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(row(db, "apiwins", "long").lastStatus).toBe("running");
  });

  it("aborts an in-flight isolated run when the plugin is disabled", async () => {
    await install(
      "disposable",
      `export default function plugin(bb: any) {
        const g = globalThis as any;
        bb.background.experimental_vkSchedule("d", "*/5 * * * *", ({ signal }: any) => {
          g.__vk.signals.d = signal;
          return g.__vk.wait("d");
        }, { isolated: true });
      }`,
    );
    makeDue("disposable", "d");
    await service.sweepDueSchedules(Date.now());
    expect(row(db, "disposable", "d").lastStatus).toBe("running");
    await service.setEnabled("disposable", false);
    expect(ctl.signals.d?.aborted).toBe(true);
    const aborted = row(db, "disposable", "d");
    expect(aborted.lastStatus).toBe("error");
    expect(aborted.lastError).toBe("aborted: plugin stopped or reloaded");
    // The late settlement of the old run must not overwrite anything.
    ctl.release("d");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(row(db, "disposable", "d").lastError).toBe(
      "aborted: plugin stopped or reloaded",
    );
    // Re-enabled: the schedule is free to start again.
    await service.setEnabled("disposable", true);
    makeDue("disposable", "d");
    await service.sweepDueSchedules(Date.now());
    expect(ctl.started.filter((s) => s === "d")).toHaveLength(2);
    expect(row(db, "disposable", "d").lastStatus).toBe("running");
  });
});
