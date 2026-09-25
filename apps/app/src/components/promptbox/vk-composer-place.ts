import { useMemo } from "react";
import type { VkComposerPlace } from "@/hooks/queries/vk-excluded-plugins-queries";
import type { newThreadEnvironmentArgsToSeed } from "@/components/plugin/new-thread-environment-seed";

export function useVkComposerPlace({
  submissionProviderInputs,
  seedOverridden,
  environmentSeed,
  effectiveEnvironmentValue,
  projectId,
  projectHostId,
  reuseEnvironmentId,
}: {
  submissionProviderInputs: unknown;
  seedOverridden: boolean;
  environmentSeed: ReturnType<typeof newThreadEnvironmentArgsToSeed> | null;
  effectiveEnvironmentValue: string;
  projectId: string;
  projectHostId: string | null;
  reuseEnvironmentId: string | null;
}): VkComposerPlace {
  const vkRawInputs: unknown =
    submissionProviderInputs ??
    (!seedOverridden &&
    environmentSeed !== null &&
    effectiveEnvironmentValue === environmentSeed.selectionValue
      ? environmentSeed.providerInputs
      : null);
  const vkInputsPath =
    vkRawInputs !== null &&
    typeof vkRawInputs === "object" &&
    !Array.isArray(vkRawInputs) &&
    typeof (vkRawInputs as Record<string, unknown>).path === "string"
      ? ((vkRawInputs as Record<string, unknown>).path as string)
      : null;
  return useMemo(
    () => ({
      projectId,
      hostId: projectHostId,
      environmentId: reuseEnvironmentId,
      path: vkInputsPath,
    }),
    [projectId, projectHostId, reuseEnvironmentId, vkInputsPath],
  );
}
