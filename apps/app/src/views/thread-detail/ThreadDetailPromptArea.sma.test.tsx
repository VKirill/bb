// @vitest-environment jsdom

import { promptAreaMocks as mocks } from "@/test/thread-detail-prompt-area-harness";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThreadWithRuntime } from "@bb/domain";
import { act, cleanup, render } from "@testing-library/react";
import { makeThreadWithRuntime } from "@bb/test-helpers/domain-fixtures";
import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { ComponentType } from "react";

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftStorage: () => mocks.promptDraft,
}));

interface CapturedComposer {
  message: string;
  onSubmit: () => void | Promise<void>;
  submitMode: { kind: string; reason?: string; onStop?: () => void };
}

const captured = vi.hoisted(() => ({ composer: null as unknown }));

function composer(): CapturedComposer {
  return captured.composer as CapturedComposer;
}

let ThreadDetailPromptArea: ComponentType<Record<string, unknown>>;

// The shared harness replaces the follow-up box with a mirror that shows only
// the submit mode's kind. These cases need the handlers the thread area hands
// to the box, so the box is replaced once more, after the harness, by one that
// keeps the props it was given.
beforeAll(async () => {
  vi.doMock("@/components/promptbox/FollowUpPromptBox", () => ({
    FollowUpPromptBox: (props: { composer: CapturedComposer | null }) => {
      captured.composer = props.composer;
      return null;
    },
  }));
  vi.resetModules();
  ({ ThreadDetailPromptArea } = (await import(
    "./ThreadDetailPromptArea"
  )) as unknown as { ThreadDetailPromptArea: ComponentType<Record<string, unknown>> });
});

let testQueryClient: QueryClient;

function makeThread(
  overrides: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return makeThreadWithRuntime({
    environmentId: null,
    id: "thr_1",
    projectId: "proj_1",
    ...overrides,
  });
}

function renderPromptArea(thread: ThreadWithRuntime) {
  return render(
    <QueryClientProvider client={testQueryClient}>
      <ThreadDetailPromptArea
        activeBackgroundCommands={[]}
        activePromptMode={null}
        activeWorkflows={[]}
        childThreadsSection={null}
        composerFocusRequestKey={0}
        composerId="thread-detail-follow-up-composer"
        isPrimaryComposer
        permissionPolicy="editable"
        canRestoreEnvironment={false}
        environmentGoneStatus={null}
        goal={null}
        providerCommands={null}
        sessionOptions={null}
        modelFallback={null}
        parentThreadSection={null}
        pendingInteractions={[]}
        queuedMessageCount={0}
        pendingTodos={null}
        projectId="proj_1"
        contextEnvironmentId={null}
        resolveMentionLink={() => null}
        sendMessage={{
          isPending: false,
          mutateAsync: mocks.sendMessageMutateAsync,
        }}
        steerActiveThreadOnEnter={false}
        thread={thread}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  captured.composer = null;
  testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.defaultExecutionOptions = null;
  mocks.executionInputSources = {};
  mocks.pluginComposerHost = null;
  mocks.promptDraft.text = "";
  mocks.promptDraft.mentions = [];
  mocks.promptDraft.attachments = [];
  mocks.promptDraft.getCurrent.mockImplementation(() => ({
    attachments: mocks.promptDraft.attachments,
    mentions: mocks.promptDraft.mentions,
    text: mocks.promptDraft.text,
  }));
  mocks.queuedMessages = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("[sma:d_chat_stop] the stop the follow-up box offers while the agent works stops that thread, by its id, once", () => {
  renderPromptArea(
    makeThread({ runtime: { displayStatus: "active" }, status: "active" }),
  );
  expect(composer().submitMode.kind).toBe("queue");
  expect(mocks.stopThreadMutate).not.toHaveBeenCalled();

  act(() => composer().submitMode.onStop!());

  expect(mocks.stopThreadMutate).toHaveBeenCalledTimes(1);
  expect(mocks.stopThreadMutate).toHaveBeenCalledWith("thr_1");
});

it("[sma:d_chat_stop] a thread that is not running offers no stop at all", () => {
  renderPromptArea(
    makeThread({ runtime: { displayStatus: "idle" }, status: "idle" }),
  );
  expect(composer().submitMode.kind).toBe("ready");
  expect(composer().submitMode.onStop).toBeUndefined();
  expect(mocks.stopThreadMutate).not.toHaveBeenCalled();
});

it("[sma:d_chat] the word typed in the box goes to the thread's send as that thread's input, and a busy thread is told to queue it", async () => {
  mocks.promptDraft.text = "Next step please";
  renderPromptArea(
    makeThread({ runtime: { displayStatus: "active" }, status: "active" }),
  );

  await act(async () => {
    await composer().onSubmit();
  });

  expect(mocks.sendMessageMutateAsync).toHaveBeenCalledTimes(1);
  expect(mocks.sendMessageMutateAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "thr_1",
      mode: "queue-if-active",
      input: [{ type: "text", text: "Next step please", mentions: [] }],
    }),
  );
});
