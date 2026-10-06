import { and, eq } from "drizzle-orm";
import {
  claimPluginScheduledRun,
  pluginSchedules,
  recordPluginScheduleResult,
  type DbConnection,
} from "@bb/db";
import type { ServerLogger } from "../../types.js";
import type {
  ExperimentalVkScheduleContext,
  ExperimentalVkScheduleOptions,
} from "@get-bb/plugin-sdk";

// VK EXPERIMENTAL: isolated cron schedules. A schedule with `isolated` is
// started by the sweep without awaiting it, so one slow run no longer holds
// every other schedule (of every plugin) back. Options come from
// `bb.background.experimental_vkSchedule(...)` or the package.json top-level
// `vk.schedules.<name>` entry; the API options win. Plain schedules are not
// touched: they keep the stock sequential, awaited run.

export const VK_SCHEDULE_DEFAULT_TIMEOUT_MS = 15 * 60_000;
export const VK_SCHEDULE_MAX_TIMEOUT_MS = 6 * 60 * 60_000;
export const VK_SCHEDULE_ISOLATED_CEILING = 8;

const OPTION_KEYS = new Set(["isolated", "timeoutMs", "overlap"]);

export interface VkScheduleManifest {
  readonly options: ReadonlyMap<string, ExperimentalVkScheduleOptions>;
  readonly warnings: readonly string[];
}

/** Keeps the valid fields of one options object; anything else is warned about and dropped. */
export function vkNormalizeScheduleOptions(
  raw: unknown,
  label: string,
  warnings: string[],
): ExperimentalVkScheduleOptions {
  const out: ExperimentalVkScheduleOptions = {};
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${label} must be an object; ignored`);
    return out;
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OPTION_KEYS.has(key)) {
      warnings.push(`${label}.${key} is unknown; ignored`);
    }
  }
  if (record.isolated !== undefined) {
    if (typeof record.isolated === "boolean") out.isolated = record.isolated;
    else warnings.push(`${label}.isolated must be a boolean; ignored`);
  }
  if (record.timeoutMs !== undefined) {
    const value = record.timeoutMs;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      warnings.push(`${label}.timeoutMs must be a positive number; ignored`);
    } else if (value > VK_SCHEDULE_MAX_TIMEOUT_MS) {
      warnings.push(
        `${label}.timeoutMs ${value} is above the maximum; clamped to ${VK_SCHEDULE_MAX_TIMEOUT_MS}`,
      );
      out.timeoutMs = VK_SCHEDULE_MAX_TIMEOUT_MS;
    } else {
      out.timeoutMs = Math.floor(value);
    }
  }
  if (record.overlap !== undefined) {
    if (record.overlap === "skip") out.overlap = "skip";
    else warnings.push(`${label}.overlap must be "skip"; ignored`);
  }
  return out;
}

/** Lenient reader of the package.json top-level `vk.schedules`; never throws. */
export function vkParseScheduleManifest(
  packageJson: unknown,
): VkScheduleManifest | undefined {
  if (packageJson === null || typeof packageJson !== "object") return undefined;
  const vk = Reflect.get(packageJson, "vk");
  if (vk === null || typeof vk !== "object") return undefined;
  const schedules = Reflect.get(vk, "schedules");
  if (schedules === undefined) return undefined;
  const warnings: string[] = [];
  const options = new Map<string, ExperimentalVkScheduleOptions>();
  if (
    schedules === null ||
    typeof schedules !== "object" ||
    Array.isArray(schedules)
  ) {
    warnings.push("vk.schedules must be an object; ignored");
  } else {
    for (const [name, raw] of Object.entries(schedules)) {
      options.set(
        name,
        vkNormalizeScheduleOptions(raw, `vk.schedules.${name}`, warnings),
      );
    }
  }
  return { options, warnings };
}

/** Spread into the manifest: a stock manifest gets no extra property. */
export function vkScheduleManifestField(packageJson: unknown): {
  vkSchedules?: VkScheduleManifest;
} {
  const vkSchedules = vkParseScheduleManifest(packageJson);
  return vkSchedules === undefined ? {} : { vkSchedules };
}

export interface VkResolvedScheduleOptions {
  timeoutMs: number;
}

interface VkScheduleRun {
  readonly pluginId: string;
  readonly name: string;
  readonly controller: AbortController;
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

type VkInvoke = (
  pluginId: string,
  label: string,
  run: () => void | Promise<void>,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export function createVkScheduleRunner(deps: {
  db: DbConnection;
  logger: ServerLogger;
  invoke: VkInvoke;
}) {
  const { db, logger } = deps;
  const running = new Map<string, VkScheduleRun>();

  function record(
    run: VkScheduleRun,
    status: "ok" | "error",
    error: string | null,
  ): boolean {
    if (run.finished) return false;
    run.finished = true;
    if (run.timer !== undefined) clearTimeout(run.timer);
    recordPluginScheduleResult(db, {
      pluginId: run.pluginId,
      name: run.name,
      status,
      error,
      now: Date.now(),
    });
    return true;
  }

  /** A skipped tick only moves next_run_at on: last_run_at and last_status stay those of the run that is going. */
  function skipTick(args: {
    pluginId: string;
    name: string;
    expectedNextRunAt: number;
    newNextRunAt: number;
    now: number;
  }): void {
    db.update(pluginSchedules)
      .set({ nextRunAt: args.newNextRunAt, updatedAt: args.now })
      .where(
        and(
          eq(pluginSchedules.pluginId, args.pluginId),
          eq(pluginSchedules.name, args.name),
          eq(pluginSchedules.nextRunAt, args.expectedNextRunAt),
        ),
      )
      .run();
  }

  return {
    /** Logs a plugin's manifest warnings; call once per load. */
    noteManifest(
      pluginId: string,
      manifest: { vkSchedules?: VkScheduleManifest },
    ): void {
      for (const warning of manifest.vkSchedules?.warnings ?? []) {
        logger.warn(`[plugin:${pluginId}] ${warning}`);
      }
    },

    /** Null for a plain schedule; otherwise the isolated run settings (API options over the manifest). */
    resolve(
      manifest: { vkSchedules?: VkScheduleManifest } | undefined,
      schedule: { name: string; vkOptions?: ExperimentalVkScheduleOptions },
    ): VkResolvedScheduleOptions | null {
      const merged = {
        ...manifest?.vkSchedules?.options.get(schedule.name),
        ...schedule.vkOptions,
      };
      if (merged.isolated !== true) return null;
      return { timeoutMs: merged.timeoutMs ?? VK_SCHEDULE_DEFAULT_TIMEOUT_MS };
    },

    /** Claims the due run and starts it without awaiting; skips the tick on overlap or at the ceiling. */
    dispatch(args: {
      pluginId: string;
      name: string;
      run: (context: ExperimentalVkScheduleContext) => void | Promise<void>;
      options: VkResolvedScheduleOptions;
      expectedNextRunAt: number;
      newNextRunAt: number;
      now: number;
    }): void {
      const { pluginId, name } = args;
      const key = `${pluginId}\u0000${name}`;
      const label = `[plugin:${pluginId}] schedule ${name}`;
      if (running.has(key)) {
        skipTick(args);
        logger.info(`${label} tick skipped: the previous run is still going`);
        return;
      }
      if (running.size >= VK_SCHEDULE_ISOLATED_CEILING) {
        skipTick(args);
        logger.warn(
          `${label} tick skipped: ${VK_SCHEDULE_ISOLATED_CEILING} isolated runs are already going`,
        );
        return;
      }
      const claimed = claimPluginScheduledRun(db, {
        pluginId,
        name,
        expectedNextRunAt: args.expectedNextRunAt,
        newNextRunAt: args.newNextRunAt,
        now: args.now,
      });
      if (!claimed) return;
      const entry: VkScheduleRun = {
        pluginId,
        name,
        controller: new AbortController(),
        finished: false,
        timer: undefined,
      };
      running.set(key, entry);
      const timeoutMs = args.options.timeoutMs;
      const timer = setTimeout(() => {
        const message = `timeout after ${timeoutMs}ms`;
        if (!record(entry, "error", message)) return;
        logger.warn(`${label} ${message}; aborting`);
        entry.controller.abort(new Error(message));
      }, timeoutMs);
      timer.unref();
      entry.timer = timer;
      // The entry stays tracked until the function settles, even after a
      // timeout: a function that ignores the signal keeps its slot and its
      // schedule is not started a second time on top of it.
      deps
        .invoke(pluginId, `schedule ${name}`, () =>
          args.run({ signal: entry.controller.signal }),
        )
        .then((outcome) =>
          record(
            entry,
            outcome.ok ? "ok" : "error",
            outcome.ok ? null : outcome.error,
          ),
        )
        .catch((error: unknown) => {
          logger.warn(
            `${label} could not record its result: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          if (running.get(key) === entry) running.delete(key);
        });
    },

    /** Dispose, reload or disable: abort the plugin's runs and free their slots. */
    abortPlugin(pluginId: string): void {
      for (const [key, entry] of [...running]) {
        if (entry.pluginId !== pluginId) continue;
        running.delete(key);
        const message = "aborted: plugin stopped or reloaded";
        if (record(entry, "error", message)) {
          entry.controller.abort(new Error(message));
        }
      }
    },

    runningCount(): number {
      return running.size;
    },
  };
}

export type VkScheduleRunner = ReturnType<typeof createVkScheduleRunner>;
