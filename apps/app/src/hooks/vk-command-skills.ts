import { vkPolicyAllows } from "@bb/domain";
import type { VkPlaceView } from "./queries/vk-excluded-plugins-queries";

/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * The `/` and `$` suggestions without the skills a session started at this
 * place would not load: a skill whose plugin the policy leaves out, or whose
 * name fails the skills filter (the same rule `buildVkRuntimeSessionPolicy`
 * applies to the session). Commands are never hidden.
 */
export function vkVisibleCommandSuggestions<
  T extends { source: string; name: string; pluginId?: string },
>(suggestions: readonly T[], view: VkPlaceView): readonly T[] {
  if (view.skills === null && view.pluginIds.size === 0) return suggestions;
  return suggestions.filter((suggestion) => {
    if (suggestion.source !== "skill") return true;
    const { name, pluginId } = suggestion;
    if (pluginId && view.pluginIds.has(pluginId)) return false;
    return vkPolicyAllows(
      view.skills ?? undefined,
      name,
      ...(pluginId ? [`${pluginId}:${name}`] : []),
    );
  });
}
