// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  ComposerAttachment,
  ExperimentalComposerRendererApi,
} from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreview } from "./AttachmentPreview";

afterEach(cleanup);

const attachmentSrcCalls: Array<[string, string | undefined]> = [];

function rendererStub(): ExperimentalComposerRendererApi {
  return {
    attachmentSrc: (path: string, projectId?: string) => {
      attachmentSrcCalls.push([path, projectId]);
      return `/files/${projectId ?? "-"}/${path}`;
    },
    input: { resolveMentionLink: () => null },
  } as unknown as ExperimentalComposerRendererApi;
}

const image: ComposerAttachment = {
  type: "localImage",
  path: "shots/one.png",
  name: "one.png",
  mimeType: "image/png",
};
const owned: ComposerAttachment = {
  type: "localImage",
  path: "shots/two.png",
  name: "two.png",
  mimeType: "image/png",
  sourceProjectId: "prj_owner",
};
const file: ComposerAttachment = {
  type: "localFile",
  path: "notes/plan.md",
  name: "plan.md",
  mimeType: "text/markdown",
};

describe("attachment viewer (SMA proofs)", () => {
  it("[sma:m_sw_attachment] a file a turn referred to shows as a thumbnail or a named pill, opens the picked image through its project, and removing sends the path", () => {
    attachmentSrcCalls.length = 0;
    const onExpand = vi.fn();
    const onRemove = vi.fn();
    const view = renderSlot(
      {
        component: (props: { expanded: number | null }) => (
          <AttachmentPreview
            attachments={[image, owned, file]}
            attachmentProjectId="prj_draft"
            expandedImageIndex={props.expanded}
            onExpandedImageIndexChange={onExpand}
            onRemoveAttachment={onRemove}
          />
        ),
      },
      { expanded: null },
      { composerRenderer: rendererStub() },
    );

    const thumbnails = view.container.querySelectorAll("img");
    expect(
      Array.from(thumbnails).map((img) => img.getAttribute("src")),
    ).toEqual([
      "/files/prj_draft/shots/one.png",
      "/files/prj_owner/shots/two.png",
    ]);
    expect(screen.getByText("plan.md").tagName).toBe("SPAN");

    fireEvent.click(screen.getByRole("button", { name: "two.png" }));
    expect(onExpand).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove plan.md" }));
    expect(onRemove).toHaveBeenCalledWith("notes/plan.md");

    view.rerender(
      <AttachmentPreview
        attachments={[image, owned, file]}
        attachmentProjectId="prj_draft"
        expandedImageIndex={1}
        onExpandedImageIndexChange={onExpand}
      />,
    );
    const opened = screen.getAllByAltText("two.png");
    expect(opened.map((img) => img.getAttribute("src"))).toContain(
      "/files/prj_owner/shots/two.png",
    );
  });

  it("[sma:m_sw_attachment] nothing is drawn for a draft without files, and the compact form counts them", () => {
    const empty = renderSlot(
      {
        component: () => (
          <AttachmentPreview
            attachments={[]}
            expandedImageIndex={null}
            onExpandedImageIndexChange={vi.fn()}
          />
        ),
      },
      {},
      { composerRenderer: rendererStub() },
    );
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();

    const compact = renderSlot(
      {
        component: () => (
          <AttachmentPreview
            compact
            attachments={[image, file]}
            expandedImageIndex={null}
            onExpandedImageIndexChange={vi.fn()}
          />
        ),
      },
      {},
      { composerRenderer: rendererStub() },
    );
    expect(screen.getByLabelText("2 attachments").textContent).toBe("2");
    compact.unmount();
  });
});
