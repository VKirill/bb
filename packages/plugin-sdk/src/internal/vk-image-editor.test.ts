import { describe, expect, it } from "vitest";
import { collectPluginAppRegistrations } from "./plugin-app-collector.js";

const Editor = () => null;

describe("app.slots.experimental_vkImageEditor", () => {
  it("collects the registration and is feature-testable", () => {
    let featureTest = false;
    const collected = collectPluginAppRegistrations({
      __bbPluginApp: true,
      setup(app) {
        featureTest =
          typeof app.slots.experimental_vkImageEditor === "function";
        app.slots.experimental_vkImageEditor({
          id: "image-editor",
          title: "Edit",
          component: Editor,
        });
      },
    });
    expect(featureTest).toBe(true);
    expect(collected.vkImageEditors).toEqual([
      { id: "image-editor", title: "Edit", component: Editor },
    ]);
  });

  it("rejects a bad id, a missing title, a missing component and duplicates", () => {
    const collect = (...registrations: Record<string, unknown>[]) =>
      collectPluginAppRegistrations({
        __bbPluginApp: true,
        setup(app) {
          for (const registration of registrations) {
            app.slots.experimental_vkImageEditor(registration as never);
          }
        },
      });
    expect(() =>
      collect({ id: "bad id", title: "Edit", component: Editor }),
    ).toThrow();
    expect(() => collect({ id: "ok", title: "", component: Editor })).toThrow();
    expect(() => collect({ id: "ok", title: "Edit" })).toThrow();
    expect(() =>
      collect(
        { id: "ok", title: "Edit", component: Editor },
        { id: "ok", title: "Edit 2", component: Editor },
      ),
    ).toThrow();
  });
});
