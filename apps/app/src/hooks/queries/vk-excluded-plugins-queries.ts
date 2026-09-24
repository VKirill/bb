import { useEffect, useSyncExternalStore } from "react";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Where a composer sits, for the session policy that may leave plugins out
 * there: a thread, or a project on a machine before the thread exists.
 */
export interface VkComposerPlace {
  environmentId?: string | null;
  hostId?: string | null;
  path?: string | null;
  projectId?: string | null;
  threadId?: string | null;
}

const EMPTY: ReadonlySet<string> = new Set();
const FRESH_MS = 15_000;

interface Entry {
  value: ReadonlySet<string>;
  fetchedAt: number;
  pending: boolean;
}

// A tiny cache of its own, so composer slots need no query provider: they
// also render in isolated trees (tests, plugin-embedded composers).
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function placeKey(place: VkComposerPlace | null): string | null {
  if (place === null || !(place.threadId || place.projectId)) return null;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(place).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (typeof value === "string" && value.length > 0) params.set(key, value);
  }
  return params.toString();
}

async function load(key: string): Promise<void> {
  const previous = cache.get(key);
  cache.set(key, {
    value: previous?.value ?? EMPTY,
    fetchedAt: previous?.fetchedAt ?? 0,
    pending: true,
  });
  let value: ReadonlySet<string> = previous?.value ?? EMPTY;
  try {
    const response = await fetch(`/api/v1/plugins/vk-excluded-plugins?${key}`);
    // A stock server has no such route: nothing is excluded then.
    if (response.ok) {
      const body = (await response.json()) as { pluginIds?: unknown };
      value = Array.isArray(body.pluginIds)
        ? new Set(
            body.pluginIds.filter((id): id is string => typeof id === "string"),
          )
        : EMPTY;
    } else {
      value = EMPTY;
    }
  } catch {
    // Offline or aborted: keep what was known.
  }
  cache.set(key, { value, fetchedAt: Date.now(), pending: false });
  notify();
}

/** The plugins the session policy leaves out at `place`; empty until known. */
export function useVkExcludedPluginIds(
  place: VkComposerPlace | null,
): ReadonlySet<string> {
  const key = placeKey(place);
  useEffect(() => {
    if (key === null) return;
    const entry = cache.get(key);
    if (entry?.pending) return;
    if (entry && Date.now() - entry.fetchedAt < FRESH_MS) return;
    void load(key);
  }, [key]);
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY : (cache.get(key)?.value ?? EMPTY)),
    () => EMPTY,
  );
}
