import type { ModelPickerOption } from "./model-picker-option";

/** VK EXPERIMENTAL — accordion groups in the native model picker. */

export const VK_UNGROUPED_MODEL_GROUP_ID = "__ungrouped__";

export interface VkModelGroup {
  id: string;
  label: string;
  /** Every model of the group, subgroups included. */
  options: ModelPickerOption[];
  /**
   * Second level for labels like `Provider/Vendor/Model`: set when the
   * group's models name at least two vendors, otherwise the group is flat.
   */
  subgroups?: VkModelGroup[];
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

/** Buckets by the label's first segment, in catalog order. */
function bucketModels(
  options: readonly ModelPickerOption[],
  getLabel: (option: ModelPickerOption) => string,
  idPrefix: string,
  ungroupedLabel: string,
): VkModelGroup[] {
  const groups = new Map<string, VkModelGroup>();
  for (const option of options) {
    const { group } = vkSplitModelGroupLabel(getLabel(option));
    const key = group ?? VK_UNGROUPED_MODEL_GROUP_ID;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = {
        id: `${idPrefix}${key}`,
        label: group ?? ungroupedLabel,
        options: [],
      };
      groups.set(key, bucket);
    }
    bucket.options.push(option);
  }
  // Models without a group of their own close the list.
  const ungrouped = groups.get(VK_UNGROUPED_MODEL_GROUP_ID);
  if (!ungrouped || idPrefix === "") return [...groups.values()];
  groups.delete(VK_UNGROUPED_MODEL_GROUP_ID);
  return [...groups.values(), ungrouped];
}

function namedGroupCount(groups: readonly VkModelGroup[]): number {
  return groups.filter(
    (group) => !group.id.endsWith(VK_UNGROUPED_MODEL_GROUP_ID),
  ).length;
}

export function vkGroupModels(
  options: readonly ModelPickerOption[],
  getLabel: (option: ModelPickerOption) => string,
  ungroupedLabel = vkUngroupedGroupLabel(),
): VkModelGroup[] {
  const groups = bucketModels(options, getLabel, "", ungroupedLabel);
  if (namedGroupCount(groups) < 2) return [];
  for (const group of groups) {
    if (group.id === VK_UNGROUPED_MODEL_GROUP_ID) continue;
    const subgroups = bucketModels(
      group.options,
      (option) => vkSplitModelGroupLabel(getLabel(option)).model,
      `${group.id}/`,
      ungroupedLabel,
    );
    if (namedGroupCount(subgroups) >= 2) group.subgroups = subgroups;
  }
  return groups;
}

/** The model's name without the group segments shown above it. */
export function vkModelLeafLabel(label: string, depth: number): string {
  let rest = label;
  for (let level = 0; level < depth; level += 1) {
    rest = vkSplitModelGroupLabel(rest).model;
  }
  return rest;
}

export function vkGroupContaining(
  groups: readonly VkModelGroup[],
  modelValue: string,
): VkModelGroup | undefined {
  return groups.find((group) =>
    group.options.some((option) => option.value === modelValue),
  );
}

/** IDs of the group and subgroup holding the model, outermost first. */
export function vkGroupPathContaining(
  groups: readonly VkModelGroup[],
  modelValue: string,
): string[] {
  const group = vkGroupContaining(groups, modelValue);
  if (!group) return [];
  const subgroup = group.subgroups
    ? vkGroupContaining(group.subgroups, modelValue)
    : undefined;
  return subgroup ? [group.id, subgroup.id] : [group.id];
}
