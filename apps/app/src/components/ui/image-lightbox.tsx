import { Video } from "@bb/shared-ui/video";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Button } from "@bb/shared-ui/button";
import { usePersistentOverlayFocus } from "@bb/shared-ui/responsive-overlay";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { useBrowserDimmingOverlay } from "@/hooks/useBrowserDimmingModal";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { IMAGE_TRANSPARENCY_CHECKER_STYLE } from "@bb/shared-ui/lib/image-preview";
import {
  constrainPanZoomOffset,
  createPanZoomTransform,
  usePanZoom,
  type PanZoomScaleLimits,
  type PanZoomView,
} from "./pan-zoom.js";
// VK EXPERIMENTAL: plugin image editor.
import type { VkImageEdit } from "@/lib/vk-image-editor";
import { VkImageEditorHost, useVkImageEditor } from "./vk-image-editor";

type ImageLightboxKeyAction = "close" | "next" | "previous";

interface ImageLightboxKeyActionInput {
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey"
  >;
  hasNavigation: boolean;
}

interface LightboxZoomableImageProps {
  alt: string;
  src: string;
  viewport: HTMLDivElement | null;
}

interface ImageLightboxProps {
  hasMultipleImages?: boolean;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  navigationStatus?: string;
  mediaType?: "image" | "video";
  imageAlt: string;
  imageSrc: string | null;
  isOpen?: boolean;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  title: string;
  /** VK EXPERIMENTAL: offer the plugin image editor for the shown image. */
  vkEdit?: VkImageEdit;
}

export function getImageLightboxKeyAction({
  event,
  hasNavigation,
}: ImageLightboxKeyActionInput): ImageLightboxKeyAction | null {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return null;
  }

  if (event.key === "Escape") {
    return "close";
  }

  if (!hasNavigation) {
    return null;
  }

  if (event.key === "ArrowLeft") {
    return "previous";
  }

  if (event.key === "ArrowRight") {
    return "next";
  }

  return null;
}

const LIGHTBOX_SCALE_LIMITS: PanZoomScaleLimits = { max: 8, min: 1 };

function LightboxZoomableImage({
  alt,
  src,
  viewport,
}: LightboxZoomableImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const constrainView = useCallback(
    (view: PanZoomView) => {
      const image = imageRef.current;
      if (image === null || viewport === null) {
        return view;
      }
      return constrainPanZoomOffset({
        contentSize: { height: image.offsetHeight, width: image.offsetWidth },
        view,
        viewportSize: {
          height: viewport.clientHeight,
          width: viewport.clientWidth,
        },
      });
    },
    [viewport],
  );
  const { isDragging, pointerHandlers, resetView, view } = usePanZoom({
    constrainView,
    enabled: true,
    limits: LIGHTBOX_SCALE_LIMITS,
    viewportElement: viewport,
  });
  const isZoomed = view.scale > LIGHTBOX_SCALE_LIMITS.min;

  return (
    <>
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        draggable={!isZoomed}
        style={{
          ...IMAGE_TRANSPARENCY_CHECKER_STYLE,
          transform: createPanZoomTransform(view),
        }}
        className={cn(
          "max-h-[82dvh] max-w-full object-contain",
          isZoomed &&
            (isDragging ? "cursor-grabbing select-none" : "cursor-grab"),
        )}
        onClick={(event) => {
          if (isZoomed) {
            event.stopPropagation();
          }
        }}
        {...(isZoomed ? pointerHandlers : {})}
      />
      {isZoomed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute left-[max(0.5rem,env(safe-area-inset-left))] top-[max(0.5rem,env(safe-area-inset-top))] size-11 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
          onClick={resetView}
          aria-label="Fit image to screen"
        >
          <Icon name="Minimize2" className="size-5" />
        </Button>
      ) : null}
    </>
  );
}

export function ImageLightbox({
  hasMultipleImages = false,
  previousDisabled = false,
  nextDisabled = false,
  navigationStatus,
  mediaType = "image",
  imageAlt,
  imageSrc,
  isOpen,
  onClose,
  onNext,
  onPrevious,
  title,
  vkEdit,
}: ImageLightboxProps) {
  const isVisible = isOpen ?? imageSrc !== null;
  // VK EXPERIMENTAL: plugin image editor state.
  const vkEditor = useVkImageEditor();
  const [vkEditing, setVkEditing] = useState(false);
  const [vkEditorCrashed, setVkEditorCrashed] = useState(false);
  const vkEditingRef = useRef(false);
  vkEditingRef.current = vkEditing && vkEdit !== undefined;
  useEffect(() => {
    if (!isVisible) setVkEditing(false);
  }, [isVisible, imageSrc]);
  const vkActive =
    vkEditing &&
    vkEdit !== undefined &&
    mediaType !== "video" &&
    vkEditor !== null &&
    imageSrc !== null &&
    !vkEditorCrashed;
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelElement, setPanelElement] = useState<HTMLDivElement | null>(null);
  const attachPanel = useCallback((element: HTMLDivElement | null) => {
    panelRef.current = element;
    setPanelElement(element);
  }, []);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => closeRef.current(), []);
  const titleId = useId();
  const scopeProps = usePortalScopeProps();
  useBrowserDimmingOverlay(isVisible);
  usePersistentOverlayFocus({
    open: isVisible,
    panelRef,
    requestClose,
    // VK EXPERIMENTAL: the editor owns Escape while it is open.
    onEscapeKeyDown: (event) => {
      if (vkEditingRef.current) event.preventDefault();
    },
  });
  const hasNavigation =
    hasMultipleImages && onPrevious !== undefined && onNext !== undefined;

  useEffect(() => {
    if (!isVisible || vkActive) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLVideoElement && event.key !== "Escape")
        return;
      const action = getImageLightboxKeyAction({
        event,
        hasNavigation,
      });
      if (!action) {
        return;
      }

      switch (action) {
        case "close":
          event.preventDefault();
          onClose();
          return;
        case "previous":
          if (!onPrevious || previousDisabled) {
            return;
          }
          event.preventDefault();
          onPrevious();
          return;
        case "next":
          if (!onNext || nextDisabled) {
            return;
          }
          event.preventDefault();
          onNext();
          return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    hasNavigation,
    isVisible,
    onClose,
    onNext,
    onPrevious,
    nextDisabled,
    previousDisabled,
    vkActive,
  ]);

  if (!isVisible) {
    return null;
  }

  return createPortal(
    <div
      ref={attachPanel}
      {...scopeProps}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={cn(
        "fixed inset-0 z-50 flex h-dvh w-full cursor-zoom-out items-center justify-center overflow-hidden bg-black/70 p-4 outline-none animate-in fade-in-0 duration-150 motion-reduce:animate-none",
        // VK EXPERIMENTAL: the plugin editor keeps its own touch gestures.
        mediaType === "image" && !vkActive && "touch-none",
      )}
      onClick={(event) => {
        if (vkActive) return;
        if (
          event.target === event.currentTarget ||
          event.target instanceof HTMLImageElement
        ) {
          onClose();
        }
      }}
    >
      <h2 id={titleId} className="sr-only">
        {title}
      </h2>
      {vkActive ? (
        // VK EXPERIMENTAL: plugin editor fills the preview.
        <div
          className="absolute inset-0 flex min-h-0 min-w-0 cursor-default flex-col"
          data-vk-image-editor=""
        >
          <VkImageEditorHost
            editor={vkEditor}
            src={imageSrc}
            edit={vkEdit}
            onCancel={() => setVkEditing(false)}
            onDone={onClose}
            onCrash={() => {
              setVkEditorCrashed(true);
              setVkEditing(false);
            }}
          />
        </div>
      ) : imageSrc && mediaType === "video" ? (
        <Video
          key={imageSrc}
          src={imageSrc}
          aria-label={imageAlt}
          controls
          autoPlay
          playsInline
          className="max-h-[82dvh] max-w-full cursor-auto"
        />
      ) : imageSrc ? (
        <LightboxZoomableImage
          key={imageSrc}
          alt={imageAlt}
          src={imageSrc}
          viewport={panelElement}
        />
      ) : (
        <div
          role="status"
          aria-label="Loading image"
          className="flex size-32 flex-col items-center justify-center gap-2 rounded-xl bg-black/35 text-sm text-white/60 sm:size-48"
        >
          <Icon name="Loading" className="size-5 animate-spin" />
          <span>Loading image…</span>
        </div>
      )}

      {hasNavigation && !vkActive ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute left-[max(0.5rem,env(safe-area-inset-left))] top-1/2 size-11 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white disabled:pointer-events-auto"
            onClick={onPrevious}
            disabled={previousDisabled}
            aria-label="Previous image"
          >
            <Icon name="ChevronLeft" className="size-5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-[max(0.5rem,env(safe-area-inset-right))] top-1/2 size-11 -translate-y-1/2 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white disabled:pointer-events-auto"
            onClick={onNext}
            disabled={nextDisabled}
            aria-label="Next image"
          >
            <Icon name="ChevronRight" className="size-5" />
          </Button>
        </>
      ) : null}

      {navigationStatus && !vkActive ? (
        <p
          role="status"
          className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] max-w-full px-4 text-center text-sm text-white"
        >
          {navigationStatus}
        </p>
      ) : null}

      {vkActive ? null : (
        <>
          {vkEdit !== undefined &&
          vkEditor !== null &&
          mediaType !== "video" &&
          imageSrc !== null &&
          !vkEditorCrashed ? (
            // VK EXPERIMENTAL: open the plugin image editor.
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-[calc(max(0.5rem,env(safe-area-inset-right))_+_3rem)] top-[max(0.5rem,env(safe-area-inset-top))] size-11 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
              onClick={() => setVkEditing(true)}
              aria-label={vkEditor.title}
            >
              <Icon name="Edit" className="size-5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))] size-11 rounded-full bg-black/45 text-white hover:bg-black/60 hover:text-white"
            onClick={onClose}
            aria-label={
              mediaType === "video"
                ? "Close video preview"
                : "Close image preview"
            }
          >
            <Icon name="X" className="size-5" />
          </Button>
        </>
      )}
    </div>,
    document.body,
  );
}
