import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type { ProjectSource } from "@bb/domain";
import type { CreateThreadEnvironmentArgs } from "@bb/server-contract";

interface ResolveComposerEnvironmentProvenanceArgs {
  projectId: string;
  projectSources: readonly ProjectSource[];
  hostId: string | undefined;
  path: string | undefined;
}

export function resolveComposerEnvironmentProvenance({
  projectId,
  projectSources,
  hostId,
  path,
}: ResolveComposerEnvironmentProvenanceArgs) {
  const hostSource =
    hostId === undefined
      ? undefined
      : findLocalPathProjectSourceForHost(projectSources, hostId);
  const projectSource =
    hostSource !== undefined &&
    (path === undefined || hostSource.path === path)
      ? hostSource
      : undefined;

  return {
    projectId,
    sectionId: null,
    ...(projectSource === undefined
      ? {}
      : { projectSourceId: projectSource.id }),
    ...(hostId === undefined ? {} : { hostId }),
    ...(path === undefined && projectSource === undefined
      ? {}
      : { path: path ?? projectSource?.path }),
  } as const;
}

export function pathFromComposerEnvironmentRequest(
  request: CreateThreadEnvironmentArgs,
): string | undefined {
  if (request.type === "host" && request.workspace.type === "unmanaged") {
    return request.workspace.path ?? undefined;
  }
  if (request.type !== "provider" || request.inputs === null) return undefined;
  if (typeof request.inputs !== "object" || Array.isArray(request.inputs)) {
    return undefined;
  }
  const path = request.inputs.path;
  return typeof path === "string" ? path : undefined;
}
