import { reasoningLevelValues, type ReasoningLevel } from "@bb/domain";

/**
 * VK EXPERIMENTAL — one reasoning ladder order for every provider.
 * Providers report levels in their own order (Grok high → low, Devin low → high);
 * the picker shows them weakest first, as Claude does. Unknown levels keep their order at the end.
 */
export function vkSortReasoningEfforts<T extends { reasoningEffort: ReasoningLevel }>(
  efforts: readonly T[],
): T[] {
  const levels: readonly string[] = reasoningLevelValues;
  const rank = (level: ReasoningLevel) => {
    const index = levels.indexOf(level);
    return index < 0 ? levels.length : index;
  };
  return [...efforts].sort((a, b) => rank(a.reasoningEffort) - rank(b.reasoningEffort));
}
