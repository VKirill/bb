import { describe, expect, it } from "vitest";
import { vkSortReasoningEfforts } from "./vk-reasoning-order";

describe("vkSortReasoningEfforts", () => {
  it("orders a descending ladder weakest first and keeps unknown levels last", () => {
    const sorted = vkSortReasoningEfforts([
      { reasoningEffort: "custom" },
      { reasoningEffort: "xhigh" },
      { reasoningEffort: "max" },
      { reasoningEffort: "high" },
      { reasoningEffort: "low" },
    ]);
    expect(sorted.map((e) => e.reasoningEffort)).toEqual(["low", "high", "xhigh", "max", "custom"]);
  });
});
