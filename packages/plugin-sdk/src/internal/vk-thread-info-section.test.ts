import { describe, expect, it } from "vitest";
import { createElement, type FunctionComponent, type ReactElement } from "react";
import { collectPluginAppRegistrations } from "./plugin-app-collector.js";
import { experimental_THREAD_INFO_SECTION_GROUPS } from "../thread-info-groups.js";

const Section = ({ threadId, projectId }: { threadId: string; projectId: string }) =>
  createElement("p", null, `${threadId}/${projectId}`);

// VK EXPERIMENTAL: since 0.47 the VK Info section is an alias of bb's own `experimental_threadInfoSection`.
describe("app.slots.experimental_vkThreadInfoSection", () => {
  it("lands among bb's Info sections after the uncommitted changes, inside its labelled group", () => {
    let featureTest = false;
    const collected = collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        featureTest = typeof app.slots.experimental_vkThreadInfoSection === "function";
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "Lane Pilot", component: Section });
      },
    });
    expect(featureTest).toBe(true);
    expect(collected.threadInfoSections).toHaveLength(1);
    const [section] = collected.threadInfoSections;
    expect(section).toMatchObject({ id: "live", group: experimental_THREAD_INFO_SECTION_GROUPS.changes, order: 30 });
    const render = section!.component as FunctionComponent<{ threadId: string; projectId: string; environment: null }>;
    const group = render({ threadId: "thr_1", projectId: "proj_1", environment: null }) as ReactElement<Record<string, unknown>>;
    expect(group.type).toBe("div");
    expect(group.props).toMatchObject({ role: "group", "aria-label": "Lane Pilot", "data-vk-thread-info-section": "live" });
    const inner = group.props.children as ReactElement<Record<string, unknown>>;
    expect(inner.type).toBe(Section);
    expect(inner.props).toEqual({ threadId: "thr_1", projectId: "proj_1" });
  });

  it("rejects a duplicate id, also against bb's own Info section slot", () => {
    expect(() => collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "A", component: Section });
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "B", component: Section });
      },
    })).toThrow();
    expect(() => collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        app.slots.experimental_threadInfoSection({ id: "live", group: "2_changes", component: Section });
        app.slots.experimental_vkThreadInfoSection({ id: "live", title: "B", component: Section });
      },
    })).toThrow();
  });
});
