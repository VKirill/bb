// VK EXPERIMENTAL: React side of the plugin image editor in the image preview.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PromptDraftAttachment } from "@bb/client-core";
import { usePluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginVkImageEditorSlot,
} from "@/lib/plugin-slots";
import {
  attachVkImageToThreadComposer,
  isVkEditableImageSrc,
  replaceVkDraftImage,
  resolveVkImageEditor,
  vkImageFileName,
  type VkImageEdit,
} from "@/lib/vk-image-editor";

/** The registered image editor, or null when no plugin provides one. */
export function useVkImageEditor(): PluginVkImageEditorSlot | null {
  const slots = useSyncExternalStore(
    subscribePluginSlots,
    getPluginSlotSnapshot,
    getPluginSlotSnapshot,
  );
  return resolveVkImageEditor(slots.vkImageEditors);
}

/** Thread whose composer receives edited images of sent messages. */
const VkMessageImageThreadContext = createContext<string | null>(null);

export function VkMessageImageThreadProvider({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  return (
    <VkMessageImageThreadContext.Provider
      value={threadId === "" ? null : threadId}
    >
      {children}
    </VkMessageImageThreadContext.Provider>
  );
}

/**
 * `vkEdit` for an image of a sent message: the edited copy goes to the draft of
 * the thread composer. Undefined outside a thread timeline or for images the
 * plugin could not fetch.
 */
export function useVkMessageImageEdit(
  alt: string,
  src: string | null,
): VkImageEdit | undefined {
  const threadId = useContext(VkMessageImageThreadContext);
  const editable = isVkEditableImageSrc(src);
  const name = editable ? vkImageFileName(alt, src) : "";
  const onDone = useCallback(
    (file: File) => attachVkImageToThreadComposer(threadId ?? "", file),
    [threadId],
  );
  return useMemo(
    () =>
      threadId !== null && editable
        ? { target: "message" as const, name, onDone }
        : undefined,
    [editable, name, onDone, threadId],
  );
}

/**
 * `vkEdit` for an image attachment of the composer draft: the edited copy
 * replaces it at the same position. Undefined when the draft cannot be written
 * from here (no composer host, no project) or the plugin could not fetch the image.
 */
export function useVkDraftImageEdit(
  attachment: PromptDraftAttachment | null,
  src: string | null,
  projectId: string | undefined,
): VkImageEdit | undefined {
  const host = usePluginComposerHost();
  const oldPath = attachment?.path;
  const name = attachment?.name;
  return useMemo(
    () =>
      host !== null &&
      oldPath !== undefined &&
      name !== undefined &&
      projectId !== undefined &&
      projectId !== "" &&
      isVkEditableImageSrc(src)
        ? {
            target: "draft" as const,
            name,
            onDone: (file: File) =>
              replaceVkDraftImage({ host, projectId, oldPath, file }),
          }
        : undefined,
    [host, name, oldPath, projectId, src],
  );
}

/** The plugin editor, mounted like any other plugin slot and sized to fill its parent. */
export function VkImageEditorHost({
  editor,
  src,
  edit,
  onCancel,
  onDone,
  onCrash,
}: {
  editor: PluginVkImageEditorSlot;
  src: string;
  edit: VkImageEdit;
  onCancel: () => void;
  onDone: () => void;
  onCrash: () => void;
}) {
  const Editor = editor.component;
  const done = useCallback(
    async (file: File) => {
      await edit.onDone(file);
      onDone();
    },
    [edit, onDone],
  );
  return (
    <PluginSlotMount
      key={`${editor.pluginId}/${editor.id}/${editor.generation}`}
      pluginId={editor.pluginId}
      slotKind="experimental_vkImageEditor"
      slotId={editor.id}
      crashFallback={null}
      onCrash={onCrash}
    >
      <Editor
        src={src}
        name={edit.name}
        target={edit.target}
        done={done}
        cancel={onCancel}
      />
    </PluginSlotMount>
  );
}
