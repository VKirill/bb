import { describe, expect, it } from "vitest";
import { vkVisibleCommandSuggestions } from "./vk-command-skills";

// VK EXPERIMENTAL: `/` hides the skills a place's session policy leaves out.
const items = [
  { source: "command", name: "compact" },
  { source: "skill", name: "git" },
  { source: "skill", name: "seo-agent" },
  { source: "skill", name: "roll", pluginId: "agency" },
];
const names = (list: readonly { name: string }[]) => list.map((i) => i.name);

describe("vkVisibleCommandSuggestions", () => {
  it("passes everything through without a policy", () => {
    const view = { pluginIds: new Set<string>(), skills: null };
    expect(vkVisibleCommandSuggestions(items, view)).toBe(items);
  });

  it("drops skills the filter or an excluded plugin leaves out, never commands", () => {
    expect(
      names(
        vkVisibleCommandSuggestions(items, {
          pluginIds: new Set(["agency"]),
          skills: { mode: "deny", names: ["seo-agent"] },
        }),
      ),
    ).toEqual(["compact", "git"]);
    expect(
      names(
        vkVisibleCommandSuggestions(items, {
          pluginIds: new Set(),
          skills: { mode: "allow", names: ["git", "agency:roll"] },
        }),
      ),
    ).toEqual(["compact", "git", "roll"]);
  });
});
