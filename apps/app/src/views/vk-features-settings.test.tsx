// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defaultExperiments, vkFeatures } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleExperimentKeys } from "./SettingsView";
import {
  VK_ALWAYS_ON_BADGE,
  VkFeaturesSettingsSection,
} from "./vk-features-settings";

afterEach(cleanup);

describe("VkFeaturesSettingsSection", () => {
  it("lists every VK function with its Russian name and description", () => {
    render(
      <VkFeaturesSettingsSection
        disabled={false}
        experiments={defaultExperiments}
        onSwitchChange={vi.fn()}
      />,
    );
    for (const feature of vkFeatures) {
      expect(screen.getAllByText(feature.label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(VK_ALWAYS_ON_BADGE).length).toBeGreaterThan(5);
  });

  it("switches a function off through its toggle, and offers no toggle for always-on ones", () => {
    const onSwitchChange = vi.fn();
    render(
      <VkFeaturesSettingsSection
        disabled={false}
        experiments={defaultExperiments}
        onSwitchChange={onSwitchChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Избранные модели" }));
    expect(onSwitchChange).toHaveBeenCalledWith("vkFavoriteModels", false);
    expect(screen.queryByRole("switch", { name: "Политика сессии" })).toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(
      vkFeatures.filter((feature) => feature.kind === "switch").length,
    );
  });

  it("shows owner login off with the variable that enables it", () => {
    render(
      <VkFeaturesSettingsSection
        disabled={false}
        experiments={defaultExperiments}
        onSwitchChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Включается переменной BB_VK_OWNER_AUTH=1 на сервере/),
    ).toBeTruthy();
  });
});

describe("upstream Experiments list", () => {
  it("does not list VK switches", () => {
    expect(visibleExperimentKeys(true).filter((key) => key.startsWith("vk"))).toEqual([]);
  });
});
