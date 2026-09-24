import { getEnvironment, getHost, getProject, getThread } from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  listPluginVkContextContributions,
  resolvePluginVkSessionPolicy,
} from "../plugins/plugin-agent-contributions.js";
import { resolveDeprecatedWorkspaceProvisionType } from "../environments/environment-response.js";
import { vkPluginAllowed } from "./vk-session-policy.js";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * A place in the tree a session policy applies to: a thread, or — before a
 * thread exists — a project on a machine with an optional environment or
 * workspace path (the new-thread composer).
 */
export interface VkPlace {
  environmentId?: string | null;
  hostId?: string | null;
  path?: string | null;
  projectId?: string | null;
  threadId?: string | null;
}

/**
 * The plugins the session policy of `place` leaves out, which BB then treats
 * as absent there: no composer UI, no dispatch hooks, nothing in the session.
 * The plugin that supplies the policy is never excluded, or the rules could
 * switch themselves off. Resolver failures and places BB cannot resolve mean
 * nothing is excluded.
 */
export async function resolveVkExcludedPluginIds(
  db: DbConnection,
  place: VkPlace,
): Promise<ReadonlySet<string>> {
  const thread = place.threadId ? getThread(db, place.threadId) : null;
  const projectId = thread?.projectId ?? place.projectId ?? null;
  if (!projectId) return new Set();
  const project = getProject(db, projectId);
  if (!project) return new Set();
  const environmentId = thread?.environmentId ?? place.environmentId ?? null;
  const environment = environmentId ? getEnvironment(db, environmentId) : null;
  const hostId = environment?.hostId ?? place.hostId ?? null;
  const host = hostId ? getHost(db, hostId) : null;

  const resolved = await resolvePluginVkSessionPolicy({
    context: {
      thread: {
        id: thread?.id ?? "",
        title: thread?.title ?? null,
        parentThreadId: thread?.parentThreadId ?? null,
        sourceThreadId: thread?.sourceThreadId ?? null,
      },
      project: {
        id: project.id,
        kind: project.kind,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
      },
      environment: {
        id: environment?.id ?? "",
        name: environment?.name ?? null,
        path: environment?.path ?? place.path ?? null,
        branchName: environment?.branchName ?? null,
        workspaceProvisionType: environment
          ? resolveDeprecatedWorkspaceProvisionType(
              environment.environmentProviderId,
            )
          : null,
      },
      host: { id: host?.id ?? "", name: host?.name ?? "" },
      provider: {
        id: thread?.providerId ?? "",
        model: "",
        capabilities: { supportsNativeUserQuestion: false },
      },
      origin: {
        kind: thread?.originKind ?? null,
        pluginId: thread?.originPluginId ?? null,
      },
    } as Parameters<typeof resolvePluginVkSessionPolicy>[0]["context"],
  });
  if (resolved === null) return new Set();
  return new Set(
    listPluginVkContextContributions()
      .map((entry) => entry.pluginId)
      .filter(
        (pluginId) =>
          pluginId !== resolved.pluginId &&
          !vkPluginAllowed(resolved.policy, pluginId),
      ),
  );
}
