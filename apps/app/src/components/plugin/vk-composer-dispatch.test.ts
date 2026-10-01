import { describe, expect, it } from "vitest";
import { createVkComposerDispatch } from "./vk-composer-dispatch";

describe("composer dispatch attachment", () => {
  it("isolates composers, retains failed sends and clears only accepted data", () => {
    const a = createVkComposerDispatch();
    const b = createVkComposerDispatch();
    a.set("lane-pilot", { token: "one" });
    const first = a.resolve();
    expect(b.resolve()).toBeUndefined();
    expect(a.resolve()).toBe(first);
    a.set("lane-pilot", { token: "two" });
    a.accepted(first);
    expect(a.resolve()?.data).toEqual({ token: "two" });
    a.accepted(a.resolve());
    expect(a.resolve()).toBeUndefined();
  });
  it("prevents another plugin from replacing or clearing ownership", () => {
    const a = createVkComposerDispatch();
    a.set("lane-pilot", { token: "one" });
    expect(() => a.set("other", {})).toThrow(/Another plugin/);
    expect(() => a.resolve({ pluginId: "other", data: {} })).toThrow(
      /Another plugin/,
    );
    a.set("other", null);
    expect(a.resolve()?.pluginId).toBe("lane-pilot");
    a.set("lane-pilot", null);
    expect(a.resolve()).toBeUndefined();
  });
});
