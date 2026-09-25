import { readPluginManifest, type PluginManifest } from "./manifest.js";
import type { InstalledPluginRow } from "@bb/db";
import type { PluginHostArtifactSnapshot } from "./plugin-service-internal.js";
import type { ExperimentalVkPluginLifecycleAction } from "@get-bb/plugin-sdk";
import {
  deletePluginKvValue,
  getPluginKvValue,
  listPluginKvKeys,
  setPluginKvValue,
  type DbConnection,
} from "@bb/db";
import type {
  ExperimentalVkPluginLifecycleContext,
  ExperimentalVkPluginLifecycleHandler,
} from "@get-bb/plugin-sdk";

export const VK_LIFECYCLE_REGISTERED_KEY = "__vk.lifecycle.registered";

export async function runVkPluginLifecycle(input: {
  pluginId: string;
  action: ExperimentalVkPluginLifecycleContext["action"];
  db: DbConnection;
  module: unknown;
  callHost: ExperimentalVkPluginLifecycleContext["callHost"];
  timeoutMs?: number;
}): Promise<boolean> {
  const handler =
    input.module !== null && typeof input.module === "object"
      ? Reflect.get(input.module, "experimental_vkLifecycle")
      : undefined;
  if (handler === undefined) {
    if (
      getPluginKvValue(
        input.db,
        input.pluginId,
        VK_LIFECYCLE_REGISTERED_KEY,
      ) === "true"
    ) {
      throw new Error("Registered experimental_vkLifecycle export is missing");
    }
    return false;
  }
  if (typeof handler !== "function") {
    throw new Error("experimental_vkLifecycle must be a function");
  }
  setPluginKvValue(
    input.db,
    input.pluginId,
    VK_LIFECYCLE_REGISTERED_KEY,
    "true",
  );
  let active = true;
  const controller = new AbortController();
  const assertActive = () => {
    if (!active) throw new Error("Plugin lifecycle context has expired");
  };
  const context: ExperimentalVkPluginLifecycleContext = {
    pluginId: input.pluginId,
    action: input.action,
    signal: controller.signal,
    kv: {
      async get(key) {
        assertActive();
        const raw = getPluginKvValue(input.db, input.pluginId, key);
        return raw === undefined ? undefined : JSON.parse(raw);
      },
      async set(key, value) {
        assertActive();
        const json = JSON.stringify(value);
        if (json === undefined || Buffer.byteLength(json) > 256 * 1024) {
          throw new Error("Lifecycle kv requires JSON of at most 256KB");
        }
        setPluginKvValue(input.db, input.pluginId, key, json);
      },
      async delete(key) {
        assertActive();
        deletePluginKvValue(input.db, input.pluginId, key);
      },
      async list(prefix) {
        assertActive();
        return listPluginKvKeys(input.db, input.pluginId, prefix);
      },
    },
    async callHost(args) {
      assertActive();
      if (!args.hostId || !args.contract[args.method]) {
        throw new Error(
          "Lifecycle host call requires a host and declared method",
        );
      }
      return input.callHost({
        ...args,
        signal: args.signal
          ? AbortSignal.any([args.signal, controller.signal])
          : controller.signal,
        timeoutMs: Math.min(
          30 * 60_000,
          Math.max(1_000, args.timeoutMs ?? 30_000),
        ),
      });
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() =>
        (handler as ExperimentalVkPluginLifecycleHandler)(context),
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            active = false;
            controller.abort();
            reject(new Error(`Plugin lifecycle ${input.action} timed out`));
          },
          input.timeoutMs ?? 30 * 60_000,
        );
      }),
    ]);
    return true;
  } finally {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export function createVkPluginLifecycleRunner(input: {
  db: DbConnection;
  hostArtifacts: {
    get(id: string): PluginHostArtifactSnapshot | undefined;
    set(id: string, artifact: PluginHostArtifactSnapshot): void;
    delete(id: string): unknown;
  };
  importModule: (
    row: InstalledPluginRow,
    manifest: PluginManifest,
  ) => Promise<unknown>;
  loadHostArtifact: (
    row: InstalledPluginRow,
    manifest: PluginManifest,
  ) => Promise<PluginHostArtifactSnapshot | null>;
  callPluginHost?: (
    args: Parameters<ExperimentalVkPluginLifecycleContext["callHost"]>[0] & {
      pluginId: string;
      artifact: PluginHostArtifactSnapshot;
    },
  ) => Promise<unknown>;
  disposePluginHost?: (args: {
    pluginId: string;
    generation: string;
  }) => Promise<void>;
}) {
  const lifecyclePluginIds = new Set<string>();

  async function runLifecycle(
    row: InstalledPluginRow,
    action: ExperimentalVkPluginLifecycleAction,
    imported?: unknown,
  ): Promise<void> {
    let manifest: PluginManifest;
    let mod: unknown;
    try {
      manifest = await readPluginManifest(row.rootDir);
      mod = imported ?? (await input.importModule(row, manifest));
    } catch (error) {
      if (
        action === "enable" ||
        getPluginKvValue(input.db, row.id, VK_LIFECYCLE_REGISTERED_KEY) ===
          "true"
      )
        throw error;
      return;
    }
    const temporary: { artifact: PluginHostArtifactSnapshot | null } = {
      artifact: null,
    };
    let loadingArtifact: Promise<PluginHostArtifactSnapshot> | undefined;
    lifecyclePluginIds.add(row.id);
    try {
      await runVkPluginLifecycle({
        pluginId: row.id,
        action,
        db: input.db,
        module: mod,
        callHost: async (args) => {
          let artifact = input.hostArtifacts.get(row.id);
          if (artifact === undefined) {
            loadingArtifact ??= input
              .loadHostArtifact(row, manifest)
              .then((loaded) => {
                args.signal?.throwIfAborted();
                if (loaded === null)
                  throw new Error("Lifecycle requires bb.host");
                temporary.artifact = loaded;
                input.hostArtifacts.set(row.id, loaded);
                return loaded;
              });
            artifact = await loadingArtifact;
          }
          if (!input.callPluginHost)
            throw new Error("Host plugin transport is unavailable");
          return input.callPluginHost({ pluginId: row.id, artifact, ...args });
        },
      });
    } finally {
      lifecyclePluginIds.delete(row.id);
      if (temporary.artifact !== null) {
        try {
          await input.disposePluginHost?.({
            pluginId: row.id,
            generation: temporary.artifact.generation,
          });
        } finally {
          input.hostArtifacts.delete(row.id);
        }
      }
    }
  }

  return { runLifecycle, lifecyclePluginIds };
}
