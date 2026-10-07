import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptDraftAttachment, PromptDraftState } from "@bb/client-core";
import { createComposerHandleBinding } from "@get-bb/plugin-sdk/internal/composer-handle";
import {
  clearComposerEditorBridge,
  getComposerEditorBridge,
  publishComposerEditorBridge,
  type ComposerEditorBridge,
} from "./composer-editor-registry";
import {
  composerHandleController,
  type ComposerSource,
} from "./plugin-composer-handle";
import {
  clearLocalAttachmentPreviews,
  getLocalAttachmentPreviewSrc,
} from "./attachment-local-previews";
import {
  attachVkImageToThreadComposer,
  createVkAttachFiles,
  findVkThreadComposerBridge,
  isVkEditableImageSrc,
  replaceVkDraftAttachment,
  replaceVkDraftImage,
  resolveVkImageEditor,
  vkImageFileName,
} from "./vk-image-editor";
import {
  getPluginSlotSnapshot,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "./plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const upload = vi.hoisted(() => vi.fn());
vi.mock("./sdk", () => ({
  sdk: { projects: { attachments: { upload } } },
}));

function attachment(path: string): PromptDraftAttachment {
  return {
    type: "localImage",
    path,
    name: `${path}.png`,
    mimeType: "image/png",
    sizeBytes: 3,
  } as PromptDraftAttachment;
}

function draftOf(...paths: string[]): PromptDraftState {
  return { text: "hi", mentions: [], attachments: paths.map(attachment) };
}

const KEYS: string[] = [];

function publishComposer(
  key: string,
  threadId: string,
  overrides: Partial<ComposerEditorBridge> = {},
  scopeKind: "thread" | "queued-message" = "thread",
): ComposerEditorBridge {
  const bridge = {
    host: {
      scope:
        scopeKind === "thread"
          ? { kind: "thread", threadId }
          : { kind: "queued-message", threadId, queuedMessageId: "q1" },
      textEffectKey: key,
      getCurrent: () => draftOf(),
      subscribeDraft: () => () => {},
      setDraft: () => {},
      focus: () => {},
    },
    pluginCustomizable: true,
    state: {} as ComposerEditorBridge["state"],
    insertAtCursor: () => true,
    openPopup: () => false,
    closePopup: () => false,
    isPopupOpen: () => false,
    ...overrides,
  } as ComposerEditorBridge;
  publishComposerEditorBridge(key, bridge);
  KEYS.push(key);
  return bridge;
}

afterEach(() => {
  KEYS.splice(0).forEach((key) => {
    const bridge = getComposerEditorBridge(key);
    if (bridge) clearComposerEditorBridge(key, bridge);
  });
  resetPluginSlotStoreForTest();
  clearLocalAttachmentPreviews();
  upload.mockReset();
  vi.restoreAllMocks();
});

describe("image editor slot", () => {
  it("the first enabled registration, plugins sorted by id, wins", () => {
    const Editor = () => null;
    setPluginSlotRegistrations(
      "zeta",
      makePluginRegistrationSet({
        vkImageEditors: [{ id: "z", title: "Zeta edit", component: Editor }],
      }),
    );
    setPluginSlotRegistrations(
      "alpha",
      makePluginRegistrationSet({
        vkImageEditors: [{ id: "a", title: "Alpha edit", component: Editor }],
      }),
    );
    const slots = getPluginSlotSnapshot().vkImageEditors;
    expect(slots.map((slot) => slot.pluginId)).toEqual(["alpha", "zeta"]);
    expect(resolveVkImageEditor(slots)?.title).toBe("Alpha edit");
    expect(resolveVkImageEditor([])).toBeNull();
  });
});

describe("image helpers", () => {
  it("only offers same-origin images to the editor", () => {
    expect(isVkEditableImageSrc("blob:http://x/1", "http://x")).toBe(true);
    expect(isVkEditableImageSrc("/api/a.png", "http://x")).toBe(true);
    expect(isVkEditableImageSrc("http://x/a.png", "http://x")).toBe(true);
    expect(
      isVkEditableImageSrc("https://other.example/a.png", "http://x"),
    ).toBe(false);
    expect(isVkEditableImageSrc(null, "http://x")).toBe(false);
  });

  it("names an image from its alt text or URL", () => {
    expect(vkImageFileName("shot.png", "/x/y")).toBe("shot.png");
    expect(vkImageFileName("a screenshot", "/files/pic%201.jpg?v=2")).toBe(
      "pic 1.jpg",
    );
    expect(vkImageFileName("", "/api/content")).toBe("image.png");
  });
});

describe("draft replace", () => {
  it("swaps the attachment in at the same index", () => {
    const next = replaceVkDraftAttachment(
      draftOf("a", "b", "c"),
      "b",
      attachment("b2"),
    );
    expect(next?.attachments.map((item) => item.path)).toEqual([
      "a",
      "b2",
      "c",
    ]);
    expect(next?.text).toBe("hi");
  });

  it("returns null when the attachment left the draft", () => {
    expect(
      replaceVkDraftAttachment(draftOf("a"), "gone", attachment("n")),
    ).toBeNull();
  });

  it("uploads like a paste, replaces in place and keeps a local thumbnail", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    upload.mockResolvedValue(attachment("new"));
    let draft = draftOf("a", "old", "c");
    const file = new File(["x"], "edit.png", { type: "image/png" });
    await replaceVkDraftImage({
      host: { getCurrent: () => draft, setDraft: (next) => (draft = next) },
      projectId: "proj_1",
      oldPath: "old",
      file,
    });
    expect(upload).toHaveBeenCalledWith({
      projectId: "proj_1",
      clientFile: file,
    });
    expect(draft.attachments.map((item) => item.path)).toEqual([
      "a",
      "new",
      "c",
    ]);
    expect(getLocalAttachmentPreviewSrc("new")).toBe("blob:new");
  });

  it("rejects with a message and leaves the draft alone when the upload fails", async () => {
    upload.mockRejectedValue(new Error("boom"));
    const draft = draftOf("old");
    const setDraft = vi.fn();
    await expect(
      replaceVkDraftImage({
        host: { getCurrent: () => draft, setDraft },
        projectId: "p",
        oldPath: "old",
        file: new File(["x"], "e.png"),
      }),
    ).rejects.toThrow(/./);
    expect(setDraft).not.toHaveBeenCalled();
  });

  it("rejects when the attachment was removed during the upload", async () => {
    upload.mockResolvedValue(attachment("new"));
    const setDraft = vi.fn();
    await expect(
      replaceVkDraftImage({
        host: { getCurrent: () => draftOf("other"), setDraft },
        projectId: "p",
        oldPath: "old",
        file: new File(["x"], "e.png"),
      }),
    ).rejects.toThrow("no longer in the draft");
    expect(setDraft).not.toHaveBeenCalled();
  });
});

describe("attach to a composer", () => {
  it("attaches through the composer's own upload and focuses it", async () => {
    let count = 0;
    const focus = vi.fn();
    const attach = vi.fn(async (files: File[]) => {
      count += files.length;
    });
    const run = createVkAttachFiles(
      {
        getCurrent: () => ({
          ...draftOf(),
          attachments: Array(count).fill(attachment("x")),
        }),
        focus,
      },
      () => attach,
    );
    await run([new File(["x"], "a.png")]);
    expect(attach).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("rejects when the draft did not grow (upload failed) or there is no upload", async () => {
    const focus = vi.fn();
    const failing = createVkAttachFiles(
      { getCurrent: () => draftOf(), focus },
      () => async () => {},
    );
    await expect(failing([new File(["x"], "a.png")])).rejects.toThrow("a.png");
    const none = createVkAttachFiles(
      { getCurrent: () => draftOf(), focus },
      () => undefined,
    );
    await expect(none([new File(["x"], "a.png")])).rejects.toThrow(
      "cannot take",
    );
    expect(focus).not.toHaveBeenCalled();
  });

  it("finds the thread's main message box, not the sent-message editor or another thread", () => {
    publishComposer("sent-message:thr_1:op", "thr_1");
    publishComposer("other", "thr_2");
    publishComposer("queued", "thr_1", {}, "queued-message");
    const main = publishComposer("main", "thr_1");
    expect(findVkThreadComposerBridge("thr_1")).toBe(main);
    expect(findVkThreadComposerBridge("thr_9")).toBeNull();
  });

  it("message target: hands the edited image to the thread composer", async () => {
    const vkAttachFiles = vi.fn(async () => {});
    publishComposer("main", "thr_1", { vkAttachFiles });
    const file = new File(["x"], "edit.png");
    await attachVkImageToThreadComposer("thr_1", file);
    expect(vkAttachFiles).toHaveBeenCalledWith([file]);
    await expect(attachVkImageToThreadComposer("thr_2", file)).rejects.toThrow(
      "not on screen",
    );
  });
});

describe("useComposer().experimental_vkAttachFiles", () => {
  function handleFor(scope: ComposerSource["scope"], key: string) {
    const source: ComposerSource = {
      textEffectKey: key,
      scope,
      getCurrent: () => draftOf(),
      setDraft: () => {},
      isAvailable: () => true,
      focus: () => {},
    };
    return createComposerHandleBinding(
      key,
      composerHandleController("demo", source, {
        setTextEffect: () => {},
        setInputLock: () => {},
        onSubmitted: () => () => {},
      }),
    ).handle;
  }

  it("uploads through the mounted composer", async () => {
    const vkAttachFiles = vi.fn(async () => {});
    publishComposer("h1", "thr_1", { vkAttachFiles });
    const file = new File(["x"], "a.png");
    await handleFor(
      { kind: "thread", threadId: "thr_1" },
      "h1",
    ).experimental_vkAttachFiles([file]);
    expect(vkAttachFiles).toHaveBeenCalledWith([file]);
  });

  it("does nothing for an empty list", async () => {
    const vkAttachFiles = vi.fn(async () => {});
    publishComposer("h2", "thr_1", { vkAttachFiles });
    await handleFor(
      { kind: "thread", threadId: "thr_1" },
      "h2",
    ).experimental_vkAttachFiles([]);
    expect(vkAttachFiles).not.toHaveBeenCalled();
  });

  it("rejects for a queued-message editor and for a composer that is not on screen", async () => {
    publishComposer(
      "h3",
      "thr_1",
      { vkAttachFiles: vi.fn(async () => {}) },
      "queued-message",
    );
    await expect(
      handleFor(
        { kind: "queued-message", threadId: "thr_1", queuedMessageId: "q1" },
        "h3",
      ).experimental_vkAttachFiles([new File(["x"], "a.png")]),
    ).rejects.toThrow("queued message");
    await expect(
      handleFor(
        { kind: "new-thread", projectId: "p" },
        "absent",
      ).experimental_vkAttachFiles([new File(["x"], "a.png")]),
    ).rejects.toThrow("isn't on screen");
  });
});
