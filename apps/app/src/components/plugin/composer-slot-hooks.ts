import { useMemo, useSyncExternalStore } from "react";
import type { PluginComposerScope } from "@get-bb/plugin-sdk";
import {
  useVkExcludedPluginIds,
  type VkComposerPlace,
} from "@/hooks/queries/vk-excluded-plugins-queries";
import {
  usePluginComposerHost,
  type PluginComposerHost,
} from "./plugin-composer-host";
import {
  resolveComposerActions,
  resolveComposerBanners,
  resolveComposerDraftObservers,
  resolveComposerEditorEffects,
  resolveComposerPlusMenuItems,
} from "@/lib/plugin-slot-resolvers";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginComposerCustomizationSlot,
} from "@/lib/plugin-slots";

type ComposerScopeKind = PluginComposerScope["kind"] | null;

type ComposerRegistrations = readonly PluginComposerCustomizationSlot[];

function useComposerCustomizationRegistrations(): ComposerRegistrations {
  return useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().composerCustomizations,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.composerCustomizations,
  );
}

/**
 * VK EXPERIMENTAL: the place of the composer this slot renders in, from the
 * host's explicit place or, failing that, its scope.
 */
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

function useResolvedComposerSlot<T>(
  scopeKind: ComposerScopeKind,
  resolve: (
    registrations: ComposerRegistrations,
    kind: PluginComposerScope["kind"],
  ) => T,
  empty: () => T,
): T {
  const registrations = useComposerCustomizationRegistrations();
  // VK EXPERIMENTAL: plugins the place's session policy leaves out show no
  // composer UI there.
  const excluded = useVkExcludedPluginIds(vkPlaceOf(usePluginComposerHost()));
  return useMemo(() => {
    if (scopeKind === null) return empty();
    const visible =
      excluded.size === 0
        ? registrations
        : registrations.filter((entry) => !excluded.has(entry.pluginId));
    return resolve(visible, scopeKind);
  }, [empty, excluded, registrations, resolve, scopeKind]);
}

const emptyList = () => [];

function resolveComposerEditor(
  registrations: ComposerRegistrations,
  kind: PluginComposerScope["kind"],
) {
  return {
    effects: resolveComposerEditorEffects(registrations, kind),
    observers: resolveComposerDraftObservers(registrations, kind),
  };
}

const emptyComposerEditor = () => ({ effects: [], observers: [] });

export function useResolvedComposerActions(scopeKind: ComposerScopeKind) {
  return useResolvedComposerSlot(scopeKind, resolveComposerActions, emptyList);
}

export function useResolvedComposerBanners(scopeKind: ComposerScopeKind) {
  return useResolvedComposerSlot(scopeKind, resolveComposerBanners, emptyList);
}

export function useResolvedComposerPlusMenuItems(scopeKind: ComposerScopeKind) {
  return useResolvedComposerSlot(
    scopeKind,
    resolveComposerPlusMenuItems,
    emptyList,
  );
}

export function useResolvedComposerEditor(scopeKind: ComposerScopeKind) {
  return useResolvedComposerSlot(
    scopeKind,
    resolveComposerEditor,
    emptyComposerEditor,
  );
}
