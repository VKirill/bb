// VK EXPERIMENTAL: drain on reload and shutdown for plugins that declare `vk.lifecycle.drain`.
// The gate is in memory only. A plugin that did not declare the field never touches it, so a stock reload is unchanged.
import type { ExperimentalVkLifecycleDrainManifest } from "@get-bb/plugin-sdk";

export const VK_DRAIN_DEFAULT_TIMEOUT_MS = 30_000;
export const VK_DRAIN_MIN_TIMEOUT_MS = 1_000;
export const VK_DRAIN_MAX_TIMEOUT_MS = 600_000;

/** Longest a gate stays closed after its deadline if the reload code path never reaches `end` (a bug guard). */
const VK_DRAIN_GATE_GRACE_MS = 60_000;

export interface VkLifecycleDrainDeclaration {
  timeoutMs: number;
}

/**
 * Reads `vk.lifecycle.drain` from the package.json top level. Lenient: anything unusable means "not declared"
 * or a clamped timeout plus a warning, never a failed plugin load.
 */
export function parseVkLifecycleDrain(
  vk: unknown,
  warn: (message: string) => void,
): VkLifecycleDrainDeclaration | undefined {
  if (vk === null || typeof vk !== "object" || Array.isArray(vk))
    return undefined;
  const drain = (vk as ExperimentalVkLifecycleDrainManifest).lifecycle?.drain;
  if (drain === undefined) return undefined;
  if (drain === null || typeof drain !== "object" || Array.isArray(drain)) {
    warn(
      "vk.lifecycle.drain must be an object like { timeoutMs }; drain is off",
    );
    return undefined;
  }
  const raw = (drain as { timeoutMs?: unknown }).timeoutMs;
  if (raw === undefined) return { timeoutMs: VK_DRAIN_DEFAULT_TIMEOUT_MS };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warn(
      `vk.lifecycle.drain.timeoutMs must be a number; using ${VK_DRAIN_DEFAULT_TIMEOUT_MS}`,
    );
    return { timeoutMs: VK_DRAIN_DEFAULT_TIMEOUT_MS };
  }
  const clamped = Math.min(
    VK_DRAIN_MAX_TIMEOUT_MS,
    Math.max(VK_DRAIN_MIN_TIMEOUT_MS, Math.trunc(raw)),
  );
  if (clamped !== raw) {
    warn(
      `vk.lifecycle.drain.timeoutMs ${raw} is outside ${VK_DRAIN_MIN_TIMEOUT_MS}..${VK_DRAIN_MAX_TIMEOUT_MS}; using ${clamped}`,
    );
  }
  return { timeoutMs: clamped };
}

interface GateEntry {
  done: Promise<void>;
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Plugins currently draining: work for them waits until the new instance is live. */
export function createVkDrainGate() {
  const entries = new Map<string, GateEntry>();

  function end(pluginId: string): void {
    const entry = entries.get(pluginId);
    if (entry === undefined) return;
    entries.delete(pluginId);
    clearTimeout(entry.timer);
    entry.release();
  }

  return {
    /** Closes the gate. `maxMs` is the drain deadline; the gate opens by itself shortly after it as a safety net. */
    begin(pluginId: string, maxMs: number): void {
      end(pluginId);
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timer = setTimeout(
        () => end(pluginId),
        maxMs + VK_DRAIN_GATE_GRACE_MS,
      );
      timer.unref?.();
      entries.set(pluginId, { done, release, timer });
    },
    end,
    isDraining(pluginId: string): boolean {
      return entries.has(pluginId);
    },
    /**
     * Resolves true at once when the plugin is not draining, and when its new instance is live; false when
     * `ms` pass first. The wait is bounded by the same limit as the hook or call that waits.
     */
    async waitUpTo(pluginId: string, ms: number): Promise<boolean> {
      const entry = entries.get(pluginId);
      if (entry === undefined) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      });
      try {
        return await Promise.race([entry.done.then(() => true), timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

export type VkDrainGate = ReturnType<typeof createVkDrainGate>;
