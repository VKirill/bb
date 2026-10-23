import { describe, expect, it } from "vitest";
import { collectPluginAppRegistrations } from "./plugin-app-collector.js";

const Section = () => null;

// VK EXPERIMENTAL: a section of the thread's info panel is collected like every titled component slot.
describe("app.slots.experimental_vkThreadInfoSection", () => {
  it("collects the registration and is feature-testable", () => {
    let featureTest = false;
    const collected = collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        featureTest = typeof app.slots.experimental_vkThreadInfoSection === "function";
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "Lane Pilot", component: Section });
      },
    });
    expect(featureTest).toBe(true);
    expect(collected.vkThreadInfoSections).toEqual([{ id: "live", title: "Lane Pilot", component: Section }]);
  });

  it("rejects a duplicate id", () => {
    expect(() => collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "A", component: Section });
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "B", component: Section });
      },
    })).toThrow();
  });
});
