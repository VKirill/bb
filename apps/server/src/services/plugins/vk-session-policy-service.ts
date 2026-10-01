import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listThreadPluginMetadataRows, type DbConnection } from "@bb/db";
import {
  deepFreezePluginMetadata,
  parsePersistedPluginMetadata,
  type JsonObject,
} from "@bb/domain";
import {
  VK_REQUIRED_PLUGIN_IDS,
  vkSessionPolicySchema,
} from "@bb/domain/vk-session-policy";
import type { LoadedPlugin } from "./plugin-service-internal.js";
import type { PluginService } from "./plugin-service.js";
import type { createPluginRuntime } from "./plugin-runtime.js";
import { raceTimeout } from "./plugin-time-box.js";

const VK_SESSION_POLICY_TIMEOUT_MS = 2_000;

export function createVkSessionPolicyService({
  db,
  loaded,
  collectAgentTools,
  invokeWrapped,
}: {
  db: DbConnection;
  loaded: ReadonlyMap<string, LoadedPlugin>;
  collectAgentTools: () => readonly {
    pluginId: string;
    record: { name: string };
  }[];
  invokeWrapped: ReturnType<typeof createPluginRuntime>["invokeWrapped"];
}): Pick<
  PluginService,
  "listVkContextContributions" | "resolveVkSessionPolicy"
> {
  return {
    listVkContextContributions() {
      const tools = collectAgentTools();
      return [...loaded.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([pluginId, plugin]) => ({
          pluginId,
          required: VK_REQUIRED_PLUGIN_IDS.includes(pluginId),
          instructions: plugin.handle.instructionProvider !== null,
          configure: plugin.handle.agentConfigurationProvider !== null,
          tools: tools
            .filter((entry) => entry.pluginId === pluginId)
            .map(({ record }) => record.name)
            .sort(),
          skills: plugin.manifest.skillsRootPaths
            .flatMap((root) => vkListSkillDirs(root))
            .sort(),
        }));
    },

    async resolveVkSessionPolicy({ context }) {
      const resolvers = [...loaded.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .flatMap(([pluginId, plugin]) => {
          const resolver = plugin.handle.vkSessionPolicyResolver;
          return resolver === null ? [] : [{ pluginId, resolver }];
        });
      const metadataByPluginId = new Map<string, JsonObject>();
      if (context.thread.id !== "") {
        for (const row of listThreadPluginMetadataRows(
          db,
          context.thread.id,
          resolvers.map(({ pluginId }) => pluginId),
        )) {
          const metadata = parsePersistedPluginMetadata(row.metadataJson);
          if (metadata !== undefined) {
            metadataByPluginId.set(row.pluginId, metadata);
          }
        }
      }
      for (const { pluginId, resolver } of resolvers) {
        const outcome = await invokeWrapped(
          pluginId,
          "vk session policy",
          async () =>
            raceTimeout(
              Promise.resolve(
                resolver({
                  ...context,
                  pluginMetadata: deepFreezePluginMetadata(
                    metadataByPluginId.get(pluginId) ?? {},
                  ),
                }),
              ).then((value) => {
                if (value === null || value === undefined) return null;
                const parsed = vkSessionPolicySchema.safeParse(value);
                if (!parsed.success) {
                  throw new Error(
                    `invalid session policy: ${parsed.error.message}`,
                  );
                }
                return parsed.data;
              }),
              VK_SESSION_POLICY_TIMEOUT_MS,
              `timed out after ${VK_SESSION_POLICY_TIMEOUT_MS}ms`,
            ),
        );
        if (outcome.ok && outcome.value !== null) {
          return { pluginId, policy: outcome.value };
        }
      }
      return null;
    },
  };
}

function vkListSkillDirs(root: string): string[] {
  try {
    return readdirSync(root).filter((name) =>
      existsSync(join(root, name, "SKILL.md")),
    );
  } catch {
    return [];
  }
}
