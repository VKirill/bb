// @vitest-environment jsdom

import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Thread } from "@bb/domain";
import { makeThread as makeThreadFixture } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ThreadActionsProvider,
  useThreadActions,
} from "./ThreadActionsProvider";

const mocks = vi.hoisted(() => ({
  closePanesForThreads: vi.fn(),
  deleteThread: vi.fn(),
  inlineRename: vi.fn(),
  mutation: vi.fn(),
  navigate: vi.fn(),
  renameFromDialog: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useLocation: () => ({ hash: "", pathname: "/", search: "" }),
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("@/components/ui/app-route-anchor", () => ({
  useRouteNavigate: () => mocks.navigate,
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return { ...actual, useSetAtom: () => mocks.closePanesForThreads };
});

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

// The provider asks for two update hooks: the inline one (showErrorToast: false)
// serves renameThreadAsync, the other serves the dialog. Each gets its own spy.
vi.mock("@/hooks/mutations/thread-state-mutations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/mutations/thread-state-mutations")
    >();
  return {
    ...actual,
    useDeleteThread: () => ({
      isPending: false,
      mutate: mocks.mutation,
      mutateAsync: mocks.deleteThread,
    }),
    useMarkThreadRead: () => ({ mutate: mocks.mutation }),
    useMarkThreadUnread: () => ({ mutate: mocks.mutation }),
    usePinThread: () => ({ mutate: mocks.mutation }),
    useUnpinThread: () => ({ mutate: mocks.mutation }),
    useUpdateThread: (options?: { showErrorToast?: boolean }) =>
      options?.showErrorToast === false
        ? {
            isPending: false,
            mutate: mocks.mutation,
            mutateAsync: mocks.inlineRename,
          }
        : {
            isPending: false,
            mutate: mocks.renameFromDialog,
            mutateAsync: mocks.mutation,
          },
  };
});

vi.mock("@/lib/sdk", () => ({
  sdk: {
    environments: { archiveThreads: vi.fn() },
    threads: {
      archiveAll: vi.fn(),
      childSummary: vi.fn(),
      experimental_listCascade: vi.fn(),
      unarchive: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: { generalSettings: { confirmThreadArchive: true } },
  }),
}));

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ threadId: undefined }),
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    id: "thr_one",
    lastReadAt: null,
    latestAttentionAt: 1,
    title: "Investigate archive behavior",
    titleFallback: null,
    updatedAt: 1,
    ...overrides,
  });
}

function RenameButtons({ thread }: { thread: Thread }) {
  const { requestRename, renameThreadAsync } = useThreadActions();
  return (
    <>
      <button type="button" onClick={() => requestRename(thread)}>
        Rename in a dialog
      </button>
      <button
        type="button"
        onClick={() => void renameThreadAsync(thread.id, "Named inline")}
      >
        Rename inline
      </button>
    </>
  );
}

let queryClient: QueryClient;

function renderProvider(children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadActionsProvider>{children}</ThreadActionsProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  mocks.inlineRename.mockResolvedValue(undefined);
  mocks.closePanesForThreads.mockReturnValue({
    focusedRoute: null,
    removedAny: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("[sma:d_chat_rename] the dialog opens on the conversation's current title and saving sends the trimmed new title for that thread, then closes", async () => {
  renderProvider(<RenameButtons thread={makeThread()} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename in a dialog" }));

  const input = (await screen.findByLabelText("Thread name")) as HTMLInputElement;
  expect(input.value).toBe("Investigate archive behavior");
  fireEvent.change(input, { target: { value: "  Archive plan  " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));

  expect(mocks.renameFromDialog).toHaveBeenCalledTimes(1);
  const [request, callbacks] = mocks.renameFromDialog.mock.calls[0]!;
  expect(request).toEqual({ id: "thr_one", title: "Archive plan" });
  expect(screen.queryByLabelText("Thread name")).not.toBeNull();

  act(() => callbacks.onSuccess());
  expect(screen.queryByLabelText("Thread name")).toBeNull();
});

it("[sma:d_chat_rename] an empty title is refused in the dialog and nothing is sent", async () => {
  renderProvider(<RenameButtons thread={makeThread()} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename in a dialog" }));

  fireEvent.change(await screen.findByLabelText("Thread name"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));

  expect(await screen.findByText("Thread name cannot be empty.")).toBeDefined();
  expect(mocks.renameFromDialog).not.toHaveBeenCalled();
});

it("[sma:d_chat_rename] a rename made in the list itself sends the new title for that thread id", () => {
  renderProvider(<RenameButtons thread={makeThread({ id: "thr_two" })} />);
  fireEvent.click(screen.getByRole("button", { name: "Rename inline" }));

  expect(mocks.inlineRename).toHaveBeenCalledTimes(1);
  expect(mocks.inlineRename).toHaveBeenCalledWith({
    id: "thr_two",
    title: "Named inline",
  });
  expect(mocks.renameFromDialog).not.toHaveBeenCalled();
});
