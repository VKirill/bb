// VK EXPERIMENTAL: a fixed width so the picker does not jump between providers.
export const MODEL_PICKER_MENU_WIDTH_CLASS_NAME = "w-80 max-md:w-full";

interface ModelLabelParts {
  base: string;
  tag: string | null;
}

export function splitModelLabelTag(label: string): ModelLabelParts {
  const match = label.match(/^(.*\S)\s*\(([^()]+)\)$/u);
  if (!match) {
    return { base: label, tag: null };
  }
  return { base: match[1], tag: match[2] };
}
