import { describe, expect, it } from "vitest";
import { filterSkillsConfigureRootsForIsolation } from "./claude-session-params.js";

describe("filterSkillsConfigureRootsForIsolation", () => {
  it("rejects extra configure roots when isolated allowlist is set", () => {
    expect(() =>
      filterSkillsConfigureRootsForIsolation({
        roots: [
          { id: "skill_allowed", path: "/tmp/allowed" },
          { id: "skill_extra", path: "/tmp/extra" },
        ],
        allowedIds: new Set(["skill_allowed"]),
      }),
    ).toThrow(/skills\/configure roots are outside the isolated allowlist/);
  });

  it("passes listed roots and does not filter when allowlist is off", () => {
    const listed = [{ id: "skill_allowed", path: "/tmp/allowed" }];
    expect(
      filterSkillsConfigureRootsForIsolation({
        roots: listed,
        allowedIds: new Set(["skill_allowed"]),
      }),
    ).toEqual(listed);
    expect(
      filterSkillsConfigureRootsForIsolation({
        roots: [{ id: "skill_extra", path: "/tmp/extra" }],
        allowedIds: null,
      }),
    ).toEqual([{ id: "skill_extra", path: "/tmp/extra" }]);
  });
});
