import type { QueryClient } from "@tanstack/react-query";
import type { VkSwitchKey } from "@bb/domain";
import type { SystemConfigResponse } from "@bb/server-contract";
import { systemConfigQueryKey } from "./query-keys";
import { useSystemConfig } from "./system-queries";

// VK EXPERIMENTAL: the on/off switches of «Функции VK». Before the system config
// arrives a VK function stays on, as its default is on.

export function vkFeatureEnabled(
  config: Pick<SystemConfigResponse, "experiments"> | undefined,
  key: VkSwitchKey,
): boolean {
  return config?.experiments[key] !== false;
}

export function useVkFeature(key: VkSwitchKey): boolean {
  const { data } = useSystemConfig();
  return vkFeatureEnabled(data, key);
}

export function vkFeatureEnabledInCache(
  queryClient: QueryClient,
  key: VkSwitchKey,
): boolean {
  return vkFeatureEnabled(
    queryClient.getQueryData<SystemConfigResponse>(systemConfigQueryKey()),
    key,
  );
}
