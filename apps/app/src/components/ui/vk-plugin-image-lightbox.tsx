// VK EXPERIMENTAL: `experimental_ImageLightbox` as plugins get it.
import type { ExperimentalImageLightboxProps } from "@get-bb/plugin-sdk";
import { ImageLightbox } from "./image-lightbox";
import { useVkDraftImageEdit } from "./vk-image-editor";

/**
 * The core lightbox plus the plugin image editor when the plugin names the
 * previewed composer draft attachment (bb's composer plugin does).
 */
export function VkPluginImageLightbox({
  experimental_vkDraftAttachment: draftAttachment,
  ...props
}: ExperimentalImageLightboxProps) {
  const vkEdit = useVkDraftImageEdit(
    draftAttachment ?? null,
    props.imageSrc,
    draftAttachment?.projectId,
  );
  return <ImageLightbox {...props} vkEdit={vkEdit} />;
}
