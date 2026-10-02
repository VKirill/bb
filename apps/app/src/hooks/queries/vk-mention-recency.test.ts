import { describe, expect, it } from "vitest";
import { vkSortMentionCandidatesByRecency } from "./vk-mention-recency";

describe("vkSortMentionCandidatesByRecency", () => {
  it("puts the most recently active threads first", () => {
    const threads = [
      { id: "old", updatedAt: 1 },
      { id: "new", updatedAt: 3 },
      { id: "mid", updatedAt: 2 },
    ];
    expect(vkSortMentionCandidatesByRecency(threads).map((t) => t.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("keeps a fresh thread of a later project within the limit", () => {
    const earlier = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, updatedAt: i }));
    const later = [{ id: "fresh", updatedAt: 100 }];
    const sorted = vkSortMentionCandidatesByRecency([...earlier, ...later]).slice(0, 3);
    expect(sorted.map((t) => t.id)).toContain("fresh");
  });

  it("does not mutate its input", () => {
    const threads = [{ updatedAt: 1 }, { updatedAt: 2 }];
    vkSortMentionCandidatesByRecency(threads);
    expect(threads[0].updatedAt).toBe(1);
  });
});
