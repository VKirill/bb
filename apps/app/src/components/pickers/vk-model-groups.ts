import type { ModelPickerOption } from "./model-picker-option";

/** VK EXPERIMENTAL — accordion groups in the native model picker. */

export const VK_UNGROUPED_MODEL_GROUP_ID = "__ungrouped__";

export interface VkModelGroup {
  id: string;
  label: string;
  options: ModelPickerOption[];
}

export function vkSplitModelGroupLabel(label: string): {
  group: string | null;
  model: string;
} {
  const slash = label.indexOf("/");
  if (slash <= 0 || slash >= label.length - 1) {
    return { group: null, model: label };
  }
  const group = label.slice(0, slash).trim();
  const model = label.slice(slash + 1).trim();
  if (!group || !model) return { group: null, model: label };
  return { group, model };
}

export function vkUngroupedGroupLabel(lang = defaultLang()): string {
  return lang.toLowerCase().startsWith("ru") ? "Другие" : "Other";
}

function defaultLang(): string {
  return typeof document === "undefined" ? "en" : document.documentElement.lang;
}

export function vkGroupModels(
  options: readonly ModelPickerOption[],
  getLabel: (option: ModelPickerOption) => string,
  ungroupedLabel = vkUngroupedGroupLabel(),
): VkModelGroup[] {
  const groups = new Map<string, VkModelGroup>();
  const order: string[] = [];
  for (const option of options) {
    const { group } = vkSplitModelGroupLabel(getLabel(option));
    const id = group ?? VK_UNGROUPED_MODEL_GROUP_ID;
    let bucket = groups.get(id);
    if (!bucket) {
      bucket = {
        id,
        label: group ?? ungroupedLabel,
        options: [],
      };
      groups.set(id, bucket);
      order.push(id);
    }
    bucket.options.push(option);
  }
  const named = order.filter((id) => id !== VK_UNGROUPED_MODEL_GROUP_ID);
  if (named.length < 2) return [];
  return order.map((id) => groups.get(id)!);
}

export function vkGroupContaining(
  groups: readonly VkModelGroup[],
  modelValue: string,
): VkModelGroup | undefined {
  return groups.find((group) =>
    group.options.some((option) => option.value === modelValue),
  );
}
