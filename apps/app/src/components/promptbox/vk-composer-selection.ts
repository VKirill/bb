import type {
  ExperimentalComposerEnvironmentSelection,
  ExperimentalComposerSelectionSnapshot,
} from "@get-bb/plugin-sdk";
import type { ProjectSource, ReasoningLevel, ServiceTier } from "@bb/domain";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import {
  pathFromComposerEnvironmentRequest,
  resolveComposerEnvironmentProvenance,
} from "./composer-environment-provenance";

export function buildVkComposerSelection({
  isLoadingModels,
  projectId,
  selectedProviderId,
  selectedProviderMachineUnavailable,
  submissionEnvironment,
  selectedThreadModel,
  reuseThreadOptions,
  projectSources,
  reasoningLevel,
  serviceTier,
}: {
  isLoadingModels: boolean;
  projectId: string;
  selectedProviderId: string;
  selectedProviderMachineUnavailable: boolean;
  submissionEnvironment: NewThreadRequest["environment"] | null;
  selectedThreadModel: string;
  reuseThreadOptions: readonly ReuseThreadOption[];
  projectSources: readonly ProjectSource[];
  reasoningLevel: ReasoningLevel;
  serviceTier: ServiceTier | undefined;
}): ExperimentalComposerSelectionSnapshot {
  const scope = { kind: "new-thread" as const, projectId };
  if (
    isLoadingModels ||
    projectId.length === 0 ||
    selectedProviderId.length === 0 ||
    selectedProviderMachineUnavailable ||
    submissionEnvironment === null ||
    selectedThreadModel.length === 0
  ) {
    return { status: "resolving", scope };
  }
  const reuseOption =
    submissionEnvironment.type === "reuse"
      ? reuseThreadOptions.find(
          (option) =>
            option.environmentId === submissionEnvironment.environmentId,
        )
      : undefined;
  const hostId =
    submissionEnvironment.type === "host"
      ? submissionEnvironment.hostId
      : submissionEnvironment.type === "provider" &&
          submissionEnvironment.machine?.type === "existing"
        ? submissionEnvironment.machine.hostId
        : (reuseOption?.hostId ?? undefined);
  const path =
    pathFromComposerEnvironmentRequest(submissionEnvironment) ??
    reuseOption?.path ??
    undefined;
  const environmentProvenance = resolveComposerEnvironmentProvenance({
    projectId,
    projectSources,
    hostId,
    path,
  });
  let environment: ExperimentalComposerEnvironmentSelection;
  switch (submissionEnvironment.type) {
    case "reuse":
      environment = {
        kind: "existing",
        type: "reuse",
        environmentId: submissionEnvironment.environmentId,
        ...(hostId === undefined ? {} : { hostId }),
        ...(path === undefined ? {} : { path }),
      };
      break;
    case "host":
      environment = {
        kind: "existing",
        type: "host",
        workspaceType: submissionEnvironment.workspace.type,
        ...(submissionEnvironment.hostId === undefined
          ? {}
          : { hostId: submissionEnvironment.hostId }),
        ...(submissionEnvironment.workspace.type === "unmanaged" &&
        submissionEnvironment.workspace.path !== null
          ? { path: submissionEnvironment.workspace.path }
          : {}),
      };
      break;
    case "project-default":
      environment = { kind: "existing", type: "project-default" };
      break;
    case "provider":
      environment = {
        kind: "provisioning",
        type: "provider",
        environmentProviderId: submissionEnvironment.environmentProviderId,
        ...(submissionEnvironment.machine === undefined
          ? {}
          : {
              machine:
                submissionEnvironment.machine.type === "existing"
                  ? {
                      type: "existing" as const,
                      hostId: submissionEnvironment.machine.hostId,
                    }
                  : {
                      type: "new" as const,
                      machineProviderId:
                        submissionEnvironment.machine.machineProviderId,
                    },
            }),
      };
      break;
  }
  return {
    status: "ready",
    scope,
    projectId,
    providerId: selectedProviderId,
    model: selectedThreadModel,
    reasoningLevel,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    environment,
    environmentRequest: submissionEnvironment,
    environmentProvenance,
  };
}
