import { describe, expect, it } from "vitest";
import {
  ISOLATED_EMPTY_INSTRUCTIONS_SENTINEL,
  resolveIsolatedDaemonInstructions,
} from "../../src/services/threads/isolated-skill-delivery.js";

describe("resolveIsolatedDaemonInstructions", () => {
  it("uses the min-1 sentinel when isolated instructions are empty", () => {
    expect(
      resolveIsolatedDaemonInstructions({
        joinedInstructions: "",
        isolated: true,
      }),
    ).toBe(ISOLATED_EMPTY_INSTRUCTIONS_SENTINEL);
    expect(ISOLATED_EMPTY_INSTRUCTIONS_SENTINEL.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps joined isolated text and leaves legacy empty", () => {
    expect(
      resolveIsolatedDaemonInstructions({
        joinedInstructions: "keep",
        isolated: true,
      }),
    ).toBe("keep");
    expect(
      resolveIsolatedDaemonInstructions({
        joinedInstructions: "",
        isolated: false,
      }),
    ).toBe("");
  });
});
