import { existsSync, statSync } from "node:fs";
import {
  threadStartParamsSchema as canonicalThreadStartParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { z } from "zod";
import {
  buildClaudeSessionParams,
  type ClaudeCodeSkillRoot,
} from "../session-params.js";
import { ensureClaudeSkillPlugin } from "./skill-plugins.js";

export function filterSkillsConfigureRootsForIsolation(args: {
  roots: readonly { id: string; path: string }[];
  allowedIds: ReadonlySet<string> | null;
}): readonly { id: string; path: string }[] {
  if (args.allowedIds === null) {
    return args.roots;
  }
  const extra = args.roots.filter((root) => !args.allowedIds!.has(root.id));
  if (extra.length > 0) {
    throw new Error(
      `skills/configure roots are outside the isolated allowlist: ${extra.map((root) => root.id).join(", ")}`,
    );
  }
  return args.roots;
}

export function assembleSkillPluginsOrThrow(args: {
  roots: readonly { id: string; path: string }[];
  pluginsRoot: string;
}): ClaudeCodeSkillRoot[] {
  const takenNames = new Map<string, string>();
  return args.roots.map((root) => {
    try {
      if (!existsSync(root.path) || !statSync(root.path).isDirectory()) {
        throw new Error(`skill root path is missing or not a directory: ${root.path}`);
      }
      return {
        id: root.id,
        localPluginPath: ensureClaudeSkillPlugin({
          pluginsRoot: args.pluginsRoot,
          root: { id: root.id, path: root.path },
          takenNames,
        }),
      };
    } catch (error) {
      throw new Error(
        `claude bridge: injected skill root "${root.id}" could not be assembled: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
}

export function toClaudeSessionParams(
  params: z.infer<typeof canonicalThreadStartParamsSchema>,
  args: {
    assembleSkillPlugins: (
      roots: readonly { id: string; path: string }[],
    ) => ClaudeCodeSkillRoot[];
    configuredSkillRoots: ClaudeCodeSkillRoot[] | null;
  },
): Record<string, unknown> {
  const providerOptions = params.options.providerOptions ?? {};
  const isolated = providerOptions.isolatedSkillDelivery === true;
  const isolatedSkillRoots = Array.isArray(providerOptions.isolatedSkillRoots)
    ? providerOptions.isolatedSkillRoots.filter(
        (root): root is { id: string; path: string } =>
          typeof root === "object" &&
          root !== null &&
          typeof root.id === "string" &&
          typeof root.path === "string",
      )
    : [];
  return buildClaudeSessionParams({
    threadId: params.threadId,
    cwd: params.cwd,
    options: params.options,
    instructionMode: params.instructionMode,
    dynamicTools: params.dynamicTools,
    disallowedTools: params.disallowedTools,
    skillRoots: isolated
      ? args.assembleSkillPlugins(isolatedSkillRoots)
      : (args.configuredSkillRoots ?? undefined),
  });
}
