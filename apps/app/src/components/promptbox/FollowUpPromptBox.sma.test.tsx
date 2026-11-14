// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FollowUpPromptBox,
  type FollowUpSubmitMode,
} from "@/components/promptbox/FollowUpPromptBox";
import { createInertScrollPositionKeeper } from "@/test/scroll-position-keeper";
import { testTypeaheadConfig } from "@/test/fixtures/composer-search";

interface CapturedSubmission {
  disabled?: boolean;
  disabledReason?: string;
  isRunning?: boolean;
  onStop?: () => void;
  queuesDraft?: boolean;
  title?: string;
}

const mocks = vi.hoisted(() => ({
  executionControls: vi.fn(),
  scrollToBottom: vi.fn(),
  submission: null as unknown,
}));

vi.mock("@/components/ui/bottom-anchored-scroll-body.js", () => ({
  useBottomAnchoredScroll: () => ({
    isAtBottom: false,
    scrollToBottom: mocks.scrollToBottom,
    scrollElementIntoView: vi.fn(),
    positionKeeper: createInertScrollPositionKeeper(),
    holdContentPosition: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: { keybindings: [] } }),
}));

vi.mock("@/components/promptbox/ComposerBox", () => ({
  DEFAULT_COMPOSER_SCOPE: { kind: "new-thread", projectId: null },
  ComposerBox: function ComposerBox({
    executionControls,
    onSubmit,
    submission,
  }: {
    executionControls?: ReactNode;
    onSubmit: () => void;
    submission?: CapturedSubmission;
  }) {
    mocks.submission = submission;
    return (
      <div data-testid="prompt-box">
        {executionControls}
        <input aria-label="Follow-up prompt" />
        <button type="button" onClick={() => onSubmit()}>
          Submit
        </button>
        {submission?.onStop ? (
          <button type="button" onClick={submission.onStop}>
            Stop
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock("@/components/promptbox/usePromptVoice", () => ({
  usePromptVoice: () => ({
    state: "idle",
    isSupported: false,
    stream: null,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock("@/components/promptbox/ExecutionControls", () => ({
  ExecutionControls: (props: {
    disabled?: boolean;
    provider: { selectedId?: string };
    model: { selected: string };
  }) => {
    mocks.executionControls(props);
    return (
      <div
        data-testid="execution-controls"
        data-disabled={String(props.disabled === true)}
      >
        {props.provider.selectedId}/{props.model.selected}
      </div>
    );
  },
}));

vi.mock("@/components/pickers/PermissionModePicker", () => ({
  PermissionModePicker: () => null,
}));

vi.mock("@/views/thread-detail/ThreadTimelineScrollToBottomButton", () => ({
  ThreadTimelineScrollToBottomButton: () => null,
}));

vi.mock("@/components/thread/timeline", () => ({
  ThreadContextWindowIndicator: () => null,
}));

function props(
  submitMode: FollowUpSubmitMode,
): Parameters<typeof FollowUpPromptBox>[0] {
  return {
    attachments: {
      items: [],
      projectId: "proj_test",
      isAttaching: false,
      error: null,
      onAttachFiles: vi.fn(),
      onUpdate: vi.fn(),
    },
    stack: null,
    composer: {
      history: {
        currentDraft: { text: "Next step", mentions: [], attachments: [] },
        entries: [],
        onSelectEntry: vi.fn(),
      },
      isFollowUpSubmitting: false,
      message: "Next step",
      mentionRanges: [],
      onChangeMessage: vi.fn(),
      onModifierSubmit: vi.fn(),
      onSubmit: vi.fn(),
      compactPromptPlaceholder: "Ask a follow-up",
      promptPlaceholder: "Ask for a follow-up",
      canModifierSubmit: true,
      steerActiveThreadOnEnter: false,
      submitMode,
      threadRuntimeDisplayStatus:
        submitMode.kind === "queue" ? "active" : "idle",
    },
    environmentSummary: null,
    contextWindowUsage: null,
    execution: {
      provider: { selectedId: "codex" },
      model: {
        selected: "gpt-5",
        options: [],
        moreOptions: [],
        isLoading: false,
        loadFailed: false,
        onChange: vi.fn(),
      },
      reasoning: { value: "medium", options: [], onChange: vi.fn() },
    },
    permission: {
      value: "accept-edits",
      options: [{ value: "accept-edits", label: "Accept Edits" }],
      onChange: vi.fn(),
      supported: true,
    },
    typeahead: testTypeaheadConfig(),
    collapseResetKey: "thr_test",
  };
}

function submission(): CapturedSubmission {
  return mocks.submission as CapturedSubmission;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("[sma:d_chat] sending in an idle chat hands the draft to the thread's submit once and follows the new turn to the bottom", () => {
  const p = props({ kind: "ready" });
  render(<FollowUpPromptBox {...p} />);
  expect(submission().disabled).toBe(false);
  expect(submission().title).toBe("Submit (Enter)");

  fireEvent.click(screen.getByText("Submit"));

  expect(p.composer?.onSubmit).toHaveBeenCalledTimes(1);
  expect(mocks.scrollToBottom).toHaveBeenCalledTimes(1);
});

it("[sma:d_chat] sending while the agent is still running queues the word and does not jump the view", () => {
  const onStop = vi.fn();
  const p = props({ kind: "queue", onStop } as FollowUpSubmitMode);
  render(<FollowUpPromptBox {...p} />);
  expect(submission().queuesDraft).toBe(true);
  expect(submission().title).toMatch(/^Queue follow-up \(Enter\), .+ to steer$/u);

  fireEvent.click(screen.getByText("Submit"));

  expect(p.composer?.onSubmit).toHaveBeenCalledTimes(1);
  expect(mocks.scrollToBottom).not.toHaveBeenCalled();
});

it("[sma:d_chat] a chat that cannot take a word yet refuses to send and says why", () => {
  const loading = props({
    kind: "blocked",
    reason: "loading-execution-options",
  } as FollowUpSubmitMode);
  const first = render(<FollowUpPromptBox {...loading} />);
  expect(submission().disabled).toBe(true);
  expect(submission().disabledReason).toBe("Loading models...");
  first.unmount();

  const unavailable = props({
    kind: "blocked",
    reason: "unavailable",
  } as FollowUpSubmitMode);
  render(<FollowUpPromptBox {...unavailable} />);
  expect(submission().disabled).toBe(true);
  expect(submission().disabledReason).toBe("Unavailable");
});

it("[sma:d_chat_stop] while a reply is running the box offers Stop, wired to the run's stop; an idle chat offers none", () => {
  const onStop = vi.fn();
  const running = props({ kind: "queue", onStop } as FollowUpSubmitMode);
  const first = render(<FollowUpPromptBox {...running} />);
  expect(submission().isRunning).toBe(true);
  fireEvent.click(screen.getByText("Stop"));
  expect(onStop).toHaveBeenCalledTimes(1);
  first.unmount();

  render(<FollowUpPromptBox {...props({ kind: "ready" })} />);
  expect(submission().isRunning).toBe(false);
  expect(submission().onStop).toBeUndefined();
  expect(screen.queryByText("Stop")).toBeNull();
});

it("[sma:m_sw_composer] the field carries the agent and model choice under it, showing the chat's own agent and model", () => {
  render(<FollowUpPromptBox {...props({ kind: "ready" })} />);
  const controls = screen.getByTestId("execution-controls");
  expect(controls.textContent).toBe("codex/gpt-5");
  expect(controls.getAttribute("data-disabled")).toBe("false");
  expect(screen.getByLabelText("Follow-up prompt")).toBeDefined();
});

it("[sma:m_sw_composer] the agent and model choice is locked while the chat is read-only or waits for an answer, and free otherwise", () => {
  const readOnly = render(
    <FollowUpPromptBox {...props({ kind: "ready" })} executionReadOnly />,
  );
  expect(
    screen.getByTestId("execution-controls").getAttribute("data-disabled"),
  ).toBe("true");
  readOnly.unmount();

  const pending = render(
    <FollowUpPromptBox
      {...props({ kind: "ready" })}
      pendingInteraction={<div>Pick one</div>}
    />,
  );
  expect(
    screen.getByTestId("execution-controls").getAttribute("data-disabled"),
  ).toBe("true");
  pending.unmount();

  render(<FollowUpPromptBox {...props({ kind: "ready" })} />);
  expect(
    screen.getByTestId("execution-controls").getAttribute("data-disabled"),
  ).toBe("false");
});
