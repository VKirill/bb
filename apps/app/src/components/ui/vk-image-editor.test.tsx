// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginVkImageEditorProps } from "@get-bb/plugin-sdk";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import type { VkImageEdit } from "@/lib/vk-image-editor";
import { ImageLightbox } from "./image-lightbox";
import { AttachmentPreview } from "@/components/promptbox/AttachmentPreview";
import {
  PluginComposerHostProvider,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { ConversationAttachments } from "@/components/thread/timeline/ConversationAttachments";
import { VkMessageImageThreadProvider } from "./vk-image-editor";
import {
  clearComposerEditorBridge,
  publishComposerEditorBridge,
  type ComposerEditorBridge,
} from "@/lib/composer-editor-registry";
import type { PromptDraftAttachment, PromptDraftState } from "@bb/client-core";

const upload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdk", () => ({
  sdk: { projects: { attachments: { upload } } },
}));

let lastProps: PluginVkImageEditorProps | null = null;
let crash = false;

function Editor(props: PluginVkImageEditorProps) {
  if (crash) throw new Error("editor crashed");
  lastProps = props;
  return (
    <div data-testid="editor">
      <img src={props.src} alt="in editor" />
    </div>
  );
}

function register(pluginId = "office-viewer") {
  setPluginSlotRegistrations(
    pluginId,
    makePluginRegistrationSet({
      vkImageEditors: [{ id: "image", title: "Edit image", component: Editor }],
    }),
  );
}

function Preview({ vkEdit }: { vkEdit?: VkImageEdit }) {
  const [open, setOpen] = useState(true);
  const [index, setIndex] = useState(0);
  return (
    <ImageLightbox
      imageSrc={open ? `/image-${index}.png` : null}
      imageAlt={`Image ${index}`}
      title="Image preview"
      hasMultipleImages
      onPrevious={() => setIndex(1)}
      onNext={() => setIndex(1)}
      onClose={() => setOpen(false)}
      vkEdit={vkEdit}
    />
  );
}

const edit = (onDone: VkImageEdit["onDone"]): VkImageEdit => ({
  target: "draft",
  name: "shot.png",
  onDone,
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  lastProps = null;
  crash = false;
});

it("shows no Edit button without an editor or without vkEdit", () => {
  const { unmount } = render(<Preview vkEdit={edit(async () => {})} />);
  expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
  unmount();
  register();
  render(<Preview />);
  expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
});

it("opens the plugin editor in the plugin scope and hands it the image", () => {
  register();
  render(<Preview vkEdit={edit(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  const editor = screen.getByTestId("editor");
  expect(
    editor.closest('[data-bb-plugin-root][data-bb-plugin="office-viewer"]'),
  ).not.toBeNull();
  expect(lastProps).toMatchObject({
    src: "/image-0.png",
    name: "shot.png",
    target: "draft",
  });
  expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Close image preview" }),
  ).toBeNull();
});

it("leaves Escape, arrows and image clicks to the editor while it is open", () => {
  register();
  render(<Preview vkEdit={edit(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  fireEvent.click(screen.getByRole("img", { name: "in editor" }));
  expect(screen.getByTestId("editor")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(lastProps?.src).toBe("/image-0.png");
});

it("cancel goes back to the preview", () => {
  register();
  render(<Preview vkEdit={edit(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  act(() => lastProps?.cancel());
  expect(screen.queryByTestId("editor")).toBeNull();
  expect(screen.getByRole("img", { name: "Image 0" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("done applies the file then closes the editor and the preview", async () => {
  register();
  const onDone = vi.fn(async () => {});
  render(<Preview vkEdit={edit(onDone)} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  const file = new File(["x"], "shot.png", { type: "image/png" });
  await act(async () => {
    await lastProps?.done(file);
  });
  expect(onDone).toHaveBeenCalledWith(file);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("a failed done rejects and keeps the editor open", async () => {
  register();
  render(
    <Preview
      vkEdit={edit(async () => {
        throw new Error("Upload failed");
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  await act(async () => {
    await expect(lastProps?.done(new File(["x"], "a.png"))).rejects.toThrow(
      "Upload failed",
    );
  });
  expect(screen.getByTestId("editor")).toBeTruthy();
  expect(screen.getByRole("dialog")).toBeTruthy();
});

it("falls back to the preview when the editor crashes", () => {
  register();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  crash = true;
  render(<Preview vkEdit={edit(async () => {})} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  expect(screen.getByRole("img", { name: "Image 0" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

function draftAttachment(name: string): PromptDraftAttachment {
  return {
    type: "localImage",
    path: `attachments/${name}`,
    name,
    mimeType: "image/png",
    sizeBytes: 3,
  } as PromptDraftAttachment;
}

function DraftPreview({ host }: { host: PluginComposerHost }) {
  const [index, setIndex] = useState<number | null>(null);
  return (
    <PluginComposerHostProvider value={host}>
      <AttachmentPreview
        attachments={host.getCurrent().attachments}
        attachmentProjectId="proj_1"
        expandedImageIndex={index}
        onExpandedImageIndexChange={setIndex}
      />
    </PluginComposerHostProvider>
  );
}

it("draft attachment: Edit replaces it at the same position in the draft", async () => {
  register();
  let draft: PromptDraftState = {
    text: "",
    mentions: [],
    attachments: ["a.png", "b.png", "c.png"].map(draftAttachment),
  };
  upload.mockResolvedValue(draftAttachment("b-edited.png"));
  const host = {
    scope: { kind: "thread", threadId: "thr_1" },
    textEffectKey: "main",
    getCurrent: () => draft,
    subscribeDraft: () => () => {},
    setDraft: (next: PromptDraftState) => {
      draft = next;
    },
    focus: () => {},
  } as PluginComposerHost;
  render(<DraftPreview host={host} />);
  fireEvent.click(screen.getByTitle("b.png"));
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  expect(lastProps).toMatchObject({ name: "b.png", target: "draft" });
  const file = new File(["x"], "b-edited.png", { type: "image/png" });
  await act(async () => {
    await lastProps?.done(file);
  });
  expect(upload).toHaveBeenCalledWith({
    projectId: "proj_1",
    clientFile: file,
  });
  expect(draft.attachments.map((item) => item.name)).toEqual([
    "a.png",
    "b-edited.png",
    "c.png",
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("draft attachment: no Edit button outside a composer host", () => {
  register();
  render(
    <AttachmentPreview
      attachments={[draftAttachment("a.png")]}
      attachmentProjectId="proj_1"
      expandedImageIndex={0}
      onExpandedImageIndexChange={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
});

it("sent message image: Edit attaches the result to the thread's composer draft", async () => {
  register();
  const vkAttachFiles = vi.fn(async () => {});
  const bridge = {
    host: {
      scope: { kind: "thread", threadId: "thr_1" },
      textEffectKey: "main",
    },
    vkAttachFiles,
  } as unknown as ComposerEditorBridge;
  publishComposerEditorBridge("main", bridge);
  try {
    render(
      <VkMessageImageThreadProvider threadId="thr_1">
        <ConversationAttachments
          filePaths={[]}
          imageItems={[{ alt: "photo.png", src: "/api/photo.png" }]}
        />
      </VkMessageImageThreadProvider>,
    );
    fireEvent.click(screen.getByTitle("photo.png"));
    fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
    expect(lastProps).toMatchObject({ name: "photo.png", target: "message" });
    const file = new File(["x"], "photo-edited.png", { type: "image/png" });
    await act(async () => {
      await lastProps?.done(file);
    });
    expect(vkAttachFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally {
    clearComposerEditorBridge("main", bridge);
  }
});

it("sent message image: no Edit button outside a thread timeline or for another origin", () => {
  register();
  const { unmount } = render(
    <ConversationAttachments
      filePaths={[]}
      imageItems={[{ alt: "photo.png", src: "/api/photo.png" }]}
    />,
  );
  fireEvent.click(screen.getByTitle("photo.png"));
  expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
  unmount();
  render(
    <VkMessageImageThreadProvider threadId="thr_1">
      <ConversationAttachments
        filePaths={[]}
        imageItems={[{ alt: "far.png", src: "https://cdn.example/far.png" }]}
      />
    </VkMessageImageThreadProvider>,
  );
  fireEvent.click(screen.getByTitle("far.png"));
  expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
});
