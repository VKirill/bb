import { describe, expect, it } from "vitest";
import { defaultExperiments } from "@bb/domain";
import { systemConfigQueryKey } from "./query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { vkFeatureEnabled, vkFeatureEnabledInCache } from "./vk-feature-enabled";

describe("vkFeatureEnabled", () => {
  it("stays on until the system config says off", () => {
    expect(vkFeatureEnabled(undefined, "vkFavoriteModels")).toBe(true);
    const off = makeSystemConfig({
      experiments: { ...defaultExperiments, vkFavoriteModels: false },
    });
    expect(vkFeatureEnabled(off, "vkFavoriteModels")).toBe(false);
    expect(vkFeatureEnabled(off, "vkMentionRecency")).toBe(true);
  });

  it("reads the cached system config", () => {
    const { queryClient } = createQueryClientTestHarness();
    expect(vkFeatureEnabledInCache(queryClient, "vkMentionRecency")).toBe(true);
    queryClient.setQueryData(
      systemConfigQueryKey(),
      makeSystemConfig({
        experiments: { ...defaultExperiments, vkMentionRecency: false },
      }),
    );
    expect(vkFeatureEnabledInCache(queryClient, "vkMentionRecency")).toBe(false);
  });
});
