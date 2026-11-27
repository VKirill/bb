import { describe, expect, it } from "vitest";
import { vkFilterCoreEnforcedSkillSources } from "../../../src/services/threads/vk-session-policy.js";

const sources = [{ name: "gist-content-logic" }, { name: "seo-tools" }, { name: "drmax" }];
const runtime = { version: 1 as const, bbSkillsDenied: ["seo-tools", "drmax"] };

describe("vkFilterCoreEnforcedSkillSources", () => {
  it.each(["agy", "muse", "opencode2"])("narrows the catalog for %s, whose bridge does not filter", (providerId) => {
    expect(vkFilterCoreEnforcedSkillSources(providerId, sources, runtime)).toEqual([{ name: "gist-content-logic" }]);
  });

  it.each(["claude-code", "codex", "acp-cursor", "acp-antigravity"])(
    "keeps the shared catalog for %s, whose bridge filters per session",
    (providerId) => {
      expect(vkFilterCoreEnforcedSkillSources(providerId, sources, runtime)).toEqual(sources);
    },
  );

  it("keeps everything without a policy", () => {
    expect(vkFilterCoreEnforcedSkillSources("agy", sources, null)).toEqual(sources);
  });
});
