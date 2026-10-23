import { PluginSlotMount } from "./PluginSlotMount";
import { usePluginSlots } from "@/lib/plugin-slots";

/**
 * VK EXPERIMENTAL: the plugins' sections of a thread's info panel, below the
 * uncommitted changes (`app.slots.experimental_vkThreadInfoSection`). Each one
 * mounts in its own error boundary; a section that crashes or returns null
 * shows nothing.
 */
export function VkPluginThreadInfoSections({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string;
}) {
  const { vkThreadInfoSections } = usePluginSlots();
  if (vkThreadInfoSections.length === 0) return null;
  return (
    <>
      {vkThreadInfoSections.map((slot) => {
        const Component = slot.component;
        return (
          <PluginSlotMount
            key={`${slot.pluginId}/${slot.id}/${slot.generation}/${threadId}`}
            pluginId={slot.pluginId}
            slotKind="experimental_vkThreadInfoSection"
            slotId={slot.id}
            instanceId={threadId}
            crashFallback={null}
          >
            <div role="group" aria-label={slot.title} className="min-w-0" data-vk-thread-info-section={`${slot.pluginId}/${slot.id}`}>
              <Component threadId={threadId} projectId={projectId} />
            </div>
          </PluginSlotMount>
        );
      })}
    </>
  );
}
