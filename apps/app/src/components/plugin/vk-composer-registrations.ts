import { useMemo } from "react";
import {
  useVkExcludedPluginIds,
  type VkComposerPlace,
} from "@/hooks/queries/vk-excluded-plugins-queries";
import {
  usePluginComposerHost,
  type PluginComposerHost,
} from "./plugin-composer-host";

function vkPlaceOf(host: PluginComposerHost | null): VkComposerPlace | null {
  if (host === null) return null;
  if (host.vkPlace) return host.vkPlace;
  const scope = host.scope;
  switch (scope.kind) {
    case "thread":
    case "queued-message":
      return { threadId: scope.threadId };
    case "side-chat":
      return scope.childThreadId
        ? { threadId: scope.childThreadId }
        : { projectId: scope.projectId };
    case "new-thread":
      return { projectId: scope.projectId };
    default:
      return null;
  }
}

export function useVkVisibleComposerRegistrations<
  T extends { pluginId: string },
>(registrations: readonly T[]): readonly T[] {
  const excluded = useVkExcludedPluginIds(vkPlaceOf(usePluginComposerHost()));
  return useMemo(
    () =>
      excluded.size === 0
        ? registrations
        : registrations.filter((entry) => !excluded.has(entry.pluginId)),
    [excluded, registrations],
  );
}
