import { describe, expect, it } from "vitest";
import {
  VK_UNGROUPED_MODEL_GROUP_ID,
  vkGroupContaining,
  vkGroupModels,
  vkGroupPathContaining,
  vkModelLeafLabel,
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

  it("nests Provider/Vendor/Model labels when a provider names two vendors", () => {
    const options = [
      { value: "f", label: "OpenRouter/🎁 Free/Gemma" },
      { value: "a", label: "OpenRouter/Anthropic/Claude Opus" },
      { value: "x", label: "OpenRouter/Router" },
      { value: "g", label: "OpenRouter/Google/Gemini" },
      { value: "d", label: "DeepSeek/V4 Pro" },
    ];
    const groups = vkGroupModels(options, label, "Other");
    const [openRouter, deepSeek] = groups;
    expect(openRouter?.options.map((row) => row.value)).toEqual([
      "f",
      "a",
      "x",
      "g",
    ]);
    expect(
      openRouter?.subgroups?.map((group) => [group.id, group.label]),
    ).toEqual([
      ["OpenRouter/🎁 Free", "🎁 Free"],
      ["OpenRouter/Anthropic", "Anthropic"],
      ["OpenRouter/Google", "Google"],
      ["OpenRouter/__ungrouped__", "Other"],
    ]);
    expect(deepSeek?.subgroups).toBeUndefined();
    expect(vkGroupPathContaining(groups, "g")).toEqual([
      "OpenRouter",
      "OpenRouter/Google",
    ]);
    expect(vkGroupPathContaining(groups, "d")).toEqual(["DeepSeek"]);
    expect(vkModelLeafLabel("OpenRouter/Google/Gemini", 2)).toBe("Gemini");
    expect(vkModelLeafLabel("DeepSeek/V4 Pro", 1)).toBe("V4 Pro");
  });

  it("keeps a provider with one vendor flat", () => {
    const groups = vkGroupModels(
      [
        { value: "a", label: "OpenRouter/Anthropic/Claude Opus" },
        { value: "b", label: "OpenRouter/Anthropic/Claude Haiku" },
        { value: "d", label: "DeepSeek/V4 Pro" },
      ],
      label,
    );
    expect(groups[0]?.subgroups).toBeUndefined();
  });
});
