import { describe, expect, it } from "vitest";
import {
  VK_UNGROUPED_MODEL_GROUP_ID,
  vkGroupContaining,
  vkGroupModels,
  vkSplitModelGroupLabel,
} from "./vk-model-groups";

const label = (option: { label: string }) => option.label;

describe("vk model groups", () => {
  it("splits the first slash as the provider spoiler", () => {
    expect(vkSplitModelGroupLabel("DeepSeek/DeepSeek V4 Pro")).toEqual({
      group: "DeepSeek",
      model: "DeepSeek V4 Pro",
    });
    expect(vkSplitModelGroupLabel("GPT-5.5")).toEqual({
      group: null,
      model: "GPT-5.5",
    });
  });

  it("groups by provider prefix and keeps catalog order", () => {
    const options = [
      { value: "a", label: "DeepSeek/V4 Pro" },
      { value: "b", label: "Z.AI/GLM" },
      { value: "c", label: "DeepSeek/V4.1 Flash" },
      { value: "d", label: "orphan" },
    ];
    const groups = vkGroupModels(options, label);
    expect(groups.map((group) => group.id)).toEqual([
      "DeepSeek",
      "Z.AI",
      VK_UNGROUPED_MODEL_GROUP_ID,
    ]);
    expect(groups[0]?.options.map((row) => row.value)).toEqual(["a", "c"]);
    expect(vkGroupContaining(groups, "b")?.id).toBe("Z.AI");
  });

  it("stays flat when there is only one provider family", () => {
    expect(
      vkGroupModels(
        [
          { value: "a", label: "DeepSeek/V4 Pro" },
          { value: "b", label: "DeepSeek/V4.1" },
        ],
        label,
      ),
    ).toEqual([]);
  });
});
