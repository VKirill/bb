import { describe, expect, it } from "vitest";
import {
  defaultExperiments,
  earlyAdopterExperiments,
  experimentKeys,
  vkFeatures,
  vkSwitchKeys,
} from "../src/index.js";

describe("VK features list", () => {
  const switches = vkFeatures.filter((feature) => feature.kind === "switch");

  it("has exactly one switch entry per VK experiment key", () => {
    expect(switches.map((feature) => feature.key).sort()).toEqual(
      [...vkSwitchKeys].sort(),
    );
  });

  it("registers every switch as an experiment that is on by default and for early adopters", () => {
    for (const feature of switches) {
      expect(experimentKeys).toContain(feature.key);
      expect(defaultExperiments[feature.key as keyof typeof defaultExperiments]).toBe(true);
      expect(earlyAdopterExperiments[feature.key as keyof typeof earlyAdopterExperiments]).toBe(true);
    }
  });

  it("has unique keys and Russian text on every entry", () => {
    expect(new Set(vkFeatures.map((feature) => feature.key)).size).toBe(vkFeatures.length);
    for (const feature of vkFeatures) {
      expect(feature.label).toMatch(/[а-яё]/i);
      expect(feature.description).toMatch(/[а-яё]/i);
    }
  });

  it("keeps owner login off by default behind its env variable", () => {
    expect(vkFeatures.find((feature) => feature.key === "ownerAuth")).toMatchObject({
      kind: "env",
      envVar: "BB_VK_OWNER_AUTH",
      defaultOn: false,
    });
  });
});
