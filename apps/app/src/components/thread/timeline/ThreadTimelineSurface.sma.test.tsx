// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineSurface } from "./ThreadTimelineSurface";

vi.mock("@/hooks/queries/system-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/system-queries")>()),
  useSystemConfig: () => ({ data: undefined }),
}));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = {
  activeThinking: null,
  contextBoundarySeq: null,
  isThreadTimelinePending: false,
  showOngoingIndicator: false,
  threadId: "attempt-thread",
  threadRuntimeDisplayStatus: "idle" as const,
  timelineError: false,
  workspaceRootPath: undefined,
};

type SurfaceProps = Partial<ComponentProps<typeof ThreadTimelineSurface>>;

function renderSurface(props: SurfaceProps = {}) {
  const queryClient = new QueryClient();
  const element = (next: SurfaceProps) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThreadTimelineSurface {...base} timelineRows={[]} {...props} {...next} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const view = render(element({}));
  return {
    ...view,
    update: (next: SurfaceProps) => view.rerender(element(next)),
  };
}

const rows = [
  conversationRow({ id: "ask", role: "user", seq: 1, text: "Build the form" }),
  conversationRow({
    id: "answer",
    role: "assistant",
    seq: 2,
    text: "The form is built",
  }),
];

function order(container: HTMLElement, ...texts: string[]): string[] {
  const body = container.textContent ?? "";
  return texts
    .map((text) => [body.indexOf(text), text] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text);
}

it("[sma:d_attempt] the attempt's thread shows what its agent did, in the order it happened, and ends on «Stop requested» once a stop is asked for", () => {
  const view = renderSurface({
    timelineRows: rows,
    threadRuntimeDisplayStatus: "active",
    isStopping: true,
    stoppingAnchorAt: 10,
  });
  expect(screen.getByText("Build the form")).toBeDefined();
  expect(screen.getByText("The form is built")).toBeDefined();
  expect(screen.getByText("Stop requested")).toBeDefined();
  expect(
    order(view.container, "Stop requested", "The form is built", "Build the form"),
  ).toEqual(["Build the form", "The form is built", "Stop requested"]);
});

it("[sma:d_attempt] with no stop asked there is no «Stop requested» line, and once the thread records its own interruption the line is not shown twice", () => {
  const view = renderSurface({ timelineRows: rows });
  expect(screen.queryByText("Stop requested")).toBeNull();

  view.update({
    isStopping: true,
    stoppingAnchorAt: 10,
    timelineRows: [
      ...rows,
      {
        id: "attempt-thread:stopped",
        threadId: "attempt-thread",
        turnId: null,
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        startedAt: 3,
        createdAt: 3,
        kind: "system",
        systemKind: "operation",
        operationKind: "thread-interrupted",
        title: "Interrupted",
        detail: null,
        status: "completed",
        completedAt: 3,
      },
    ],
  });
  expect(screen.getAllByText("Interrupted")).toHaveLength(1);
  expect(screen.queryByText("Stop requested")).toBeNull();
});

it("[sma:d_chat_history] when older messages exist the chat offers to load them, and pressing it asks for exactly one older page", () => {
  const onLoadOlderRows = vi.fn();
  renderSurface({
    timelineRows: rows,
    hasOlderTimelineRows: true,
    onLoadOlderRows,
  });
  const load = screen.getByRole("button", { name: "Load older messages" });
  expect((load as HTMLButtonElement).disabled).toBe(false);
  expect(onLoadOlderRows).not.toHaveBeenCalled();

  fireEvent.click(load);

  expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
});

it("[sma:d_chat_history] while an older page is coming the control says so and cannot be pressed again; with nothing older, or no way to load, there is no control", () => {
  const onLoadOlderRows = vi.fn();
  const loading = renderSurface({
    timelineRows: rows,
    hasOlderTimelineRows: true,
    isLoadingOlderTimelineRows: true,
    onLoadOlderRows,
  });
  const busy = screen.getByRole("button", { name: "Loading older messages..." });
  expect((busy as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(busy);
  expect(onLoadOlderRows).not.toHaveBeenCalled();
  loading.unmount();

  const none = renderSurface({ timelineRows: rows, onLoadOlderRows });
  expect(screen.queryByRole("button", { name: /older messages/u })).toBeNull();
  none.unmount();

  renderSurface({ timelineRows: rows, hasOlderTimelineRows: true });
  expect(screen.queryByRole("button", { name: /older messages/u })).toBeNull();
});

it("[sma:d_chat_history] a history that failed to load shows the failure instead of the rows and offers no older page", () => {
  renderSurface({
    timelineRows: rows,
    timelineError: true,
    hasOlderTimelineRows: true,
    onLoadOlderRows: vi.fn(),
  });
  expect(screen.getByText("Failed to load timeline")).toBeDefined();
  expect(screen.queryByText("The form is built")).toBeNull();
  expect(screen.queryByRole("button", { name: /older messages/u })).toBeNull();
});

it("[sma:m_sw_turn_list] the turn list shows the person's words and the agent's answer each once, in turn order", () => {
  const view = renderSurface({
    timelineRows: [
      ...rows,
      conversationRow({
        id: "ask2",
        role: "user",
        seq: 3,
        text: "Now add a test",
      }),
    ],
  });
  for (const text of ["Build the form", "The form is built", "Now add a test"]) {
    expect(screen.getAllByText(text)).toHaveLength(1);
  }
  expect(
    order(view.container, "Now add a test", "The form is built", "Build the form"),
  ).toEqual(["Build the form", "The form is built", "Now add a test"]);
});

it("[sma:m_sw_turn_list] a turn the person sent with a file shows that file by name and size under their words", () => {
  const view = renderSurface({
    timelineRows: [
      conversationRow({
        id: "ask-file",
        role: "user",
        seq: 1,
        text: "Read the notes",
        attachments: {
          webImages: 0,
          localImages: 0,
          localFiles: 1,
          imageUrls: [],
          localImagePaths: [],
          localFilePaths: ["/work/notes.md"],
          localFileDetails: [
            { path: "/work/notes.md", name: "notes.md", sizeBytes: 2048 },
          ],
        },
      }),
    ],
  });
  expect(screen.getByText("Read the notes")).toBeDefined();
  expect(screen.getAllByText("notes.md · 2.0 KB")).toHaveLength(1);
  expect(order(view.container, "notes.md · 2.0 KB", "Read the notes")).toEqual([
    "Read the notes",
    "notes.md · 2.0 KB",
  ]);
});

it("[sma:m_sw_turn_list] a turn list that is still loading shows no turns, and an empty one shows none either", () => {
  const loading = renderSurface({
    timelineRows: rows,
    isThreadTimelinePending: true,
  });
  expect(screen.queryByText("The form is built")).toBeNull();
  loading.unmount();

  const empty = renderSurface({ timelineRows: [] });
  expect(empty.container.textContent).not.toContain("Build the form");
});
