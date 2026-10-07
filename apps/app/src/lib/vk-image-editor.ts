// VK EXPERIMENTAL: plugin image editor behind the "Edit" button of the image
// preview. Pure logic (slot choice, draft replace, upload, attach to a thread's
// composer); the React side lives in components/ui/vk-image-editor.tsx.
import type { PromptDraftAttachment, PromptDraftState } from "@bb/client-core";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import {
  registerLocalAttachmentPreview,
  releaseLocalAttachmentPreview,
} from "./attachment-local-previews";
import {
  getComposerEditorBridges,
  type ComposerEditorBridge,
} from "./composer-editor-registry";
import { getMutationErrorMessage } from "./mutation-errors";
import { sdk } from "./sdk";
import type { PluginVkImageEditorSlot } from "./plugin-slots";

/** What an image preview needs to offer "Edit" for the image it shows. */
export interface VkImageEdit {
  target: "draft" | "message";
  /** File name handed to the editor. */
  name: string;
  /** Upload/replace/attach the edited image. Rejects with a user-safe message. */
  onDone(file: File): Promise<void>;
}

type AttachFiles = (files: File[]) => void | Promise<void>;

/** First registration wins; the slot snapshot is already sorted by plugin id. */
export function resolveVkImageEditor(
  slots: readonly PluginVkImageEditorSlot[],
): PluginVkImageEditorSlot | null {
  return slots[0] ?? null;
}

/** Only same-origin images can be fetched by the plugin editor. */
export function isVkEditableImageSrc(
  src: string | null,
  origin: string = typeof location === "undefined" ? "" : location.origin,
): src is string {
  if (src === null || src === "") return false;
  if (src.startsWith("blob:")) return true;
  try {
    return new URL(src, origin || undefined).origin === origin;
  } catch {
    return false;
  }
}

/** A file name for an image shown with `alt` text from `src`. */
export function vkImageFileName(alt: string, src: string): string {
  const fromAlt = alt.trim();
  if (/^[^/\\]+\.[A-Za-z0-9]{2,5}$/.test(fromAlt)) return fromAlt;
  try {
    const last = new URL(src, "http://local/").pathname.split("/").pop() ?? "";
    const decoded = decodeURIComponent(last);
    if (/\.[A-Za-z0-9]{2,5}$/.test(decoded)) return decoded;
  } catch {
    // fall through to the default name
  }
  return "image.png";
}

/**
 * The draft with `oldPath`'s attachment swapped for `uploaded` at the same
 * index, or null when `oldPath` is no longer in the draft.
 */
export function replaceVkDraftAttachment(
  draft: PromptDraftState,
  oldPath: string,
  uploaded: PromptDraftAttachment,
): PromptDraftState | null {
  const index = draft.attachments.findIndex(
    (attachment) => attachment.path === oldPath,
  );
  if (index === -1) return null;
  const attachments = [...draft.attachments];
  attachments[index] = uploaded;
  return { ...draft, attachments };
}

/** Upload one image like a paste or drop does, and remember its local thumbnail. */
export async function uploadVkImage(
  projectId: string,
  file: File,
): Promise<PromptDraftAttachment> {
  try {
    const uploaded = await sdk.projects.attachments.upload({
      projectId,
      clientFile: file,
    });
    registerLocalAttachmentPreview(uploaded.path, file);
    return uploaded;
  } catch (error) {
    throw new Error(
      getMutationErrorMessage({
        error,
        fallbackMessage: "Failed to upload the edited image.",
      }),
    );
  }
}

/** Draft target: upload the edited image and swap it in for `oldPath`. */
export async function replaceVkDraftImage(args: {
  host: Pick<PluginComposerHost, "getCurrent" | "setDraft">;
  projectId: string;
  oldPath: string;
  file: File;
}): Promise<void> {
  const uploaded = await uploadVkImage(args.projectId, args.file);
  const next = replaceVkDraftAttachment(
    args.host.getCurrent(),
    args.oldPath,
    uploaded,
  );
  if (next === null) {
    throw new Error("The attachment is no longer in the draft.");
  }
  args.host.setDraft(next);
  releaseLocalAttachmentPreview(args.oldPath);
}

/**
 * The attach function a composer exposes to plugins: uses the composer's own
 * paste/drop upload (thumbnails, pending state), checks the draft really grew,
 * then focuses the composer.
 */
export function createVkAttachFiles(
  host: Pick<PluginComposerHost, "getCurrent" | "focus">,
  getAttach: () => AttachFiles | undefined,
): (files: File[]) => Promise<void> {
  return async (files) => {
    const attach = getAttach();
    if (attach === undefined) {
      throw new Error("This composer cannot take attachments.");
    }
    const before = host.getCurrent().attachments.length;
    await attach(files);
    if (host.getCurrent().attachments.length < before + files.length) {
      throw new Error(
        `Failed to attach ${files.map((file) => file.name).join(", ")}.`,
      );
    }
    host.focus();
  };
}

/**
 * The main message box of a thread: a mounted thread-scope composer that is not
 * the sent-message editor.
 */
export function findVkThreadComposerBridge(
  threadId: string,
  bridges: readonly ComposerEditorBridge[] = getComposerEditorBridges(),
): ComposerEditorBridge | null {
  return (
    bridges.find(
      ({ host }) =>
        host.scope.kind === "thread" &&
        host.scope.threadId === threadId &&
        !host.textEffectKey.startsWith("sent-message:"),
    ) ?? null
  );
}

/** Message target: add the edited image to the thread composer's draft. */
export async function attachVkImageToThreadComposer(
  threadId: string,
  file: File,
  bridges?: readonly ComposerEditorBridge[],
): Promise<void> {
  const attach = findVkThreadComposerBridge(threadId, bridges)?.vkAttachFiles;
  if (attach === undefined) {
    throw new Error("The message box of this thread is not on screen.");
  }
  await attach([file]);
}

/** Plugin API: attach files to the composer behind `bridge` (see experimental_vkAttachFiles). */
export async function attachVkFilesToComposer(
  scopeKind: PluginComposerHost["scope"]["kind"],
  bridge: ComposerEditorBridge | null,
  files: File[],
): Promise<void> {
  if (scopeKind === "queued-message") {
    throw new Error("A queued message can't take new attachments.");
  }
  const attach = bridge?.vkAttachFiles;
  if (attach === undefined) {
    throw new Error("This composer isn't on screen.");
  }
  await attach(files);
}
