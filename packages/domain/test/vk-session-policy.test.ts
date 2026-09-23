import { describe, expect, it } from "vitest";
import {
  readVkRuntimeSessionPolicy,
  vkPolicyAllows,
  vkSessionPolicySchema,
} from "../src/vk-session-policy.js";

describe("vk session policy", () => {
  it("lets everything through without a filter", () => {
    expect(vkPolicyAllows(undefined, "anything")).toBe(true);
  });

  it("keeps only listed names in allow mode, with prefix wildcards", () => {
    const filter = {
      mode: "allow" as const,
      names: ["ru-text", "lane-stack:*"],
    };
    expect(vkPolicyAllows(filter, "ru-text")).toBe(true);
    expect(vkPolicyAllows(filter, "lane-stack:web-design")).toBe(true);
    expect(vkPolicyAllows(filter, "agency")).toBe(false);
  });

  it("drops listed names in deny mode, matching any spelling", () => {
    const filter = { mode: "deny" as const, names: ["web-design"] };
    expect(vkPolicyAllows(filter, "lane-stack:web-design", "web-design")).toBe(
      false,
    );
    expect(vkPolicyAllows(filter, "ru-text")).toBe(true);
  });

  it("reads the runtime policy from provider options and ignores junk", () => {
    const policy = { version: 1, bbSkillsDenied: ["agency"] };
    expect(readVkRuntimeSessionPolicy({ vkSessionPolicy: policy })).toEqual(
      policy,
    );
    expect(
      readVkRuntimeSessionPolicy({ vkSessionPolicy: { version: 2 } }),
    ).toBeNull();
    expect(readVkRuntimeSessionPolicy({})).toBeNull();
    expect(readVkRuntimeSessionPolicy(null)).toBeNull();
  });

  it("rejects unknown filter modes", () => {
    expect(
      vkSessionPolicySchema.safeParse({ skills: { mode: "only", names: [] } })
        .success,
    ).toBe(false);
  });
});
