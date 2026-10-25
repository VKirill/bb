// VK EXPERIMENTAL: `experimental_ImageLightbox` for plugins, with the plugin
// image editor for composer draft attachments (`experimental_vkDraftAttachment`).
import type { ExperimentalImageLightboxProps } from "@get-bb/plugin-sdk";
import { ImageLightbox } from "./image-lightbox";
import { useVkDraftImageEdit } from "./vk-image-editor";

export function VkSdkImageLightbox({
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
