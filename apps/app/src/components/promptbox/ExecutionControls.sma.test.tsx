// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ExecutionControls,
  type ExecutionControlsProps,
} from "./ExecutionControls";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";

function props(overrides: Partial<ExecutionControlsProps> = {}) {
  const onProvider = vi.fn();
  const onModel = vi.fn();
  const onReasoning = vi.fn();
  const value: ExecutionControlsProps = {
    provider: {
      options: [
        { value: "codex", label: "Codex" },
        { value: "claude", label: "Claude Code" },
      ],
      selectedId: "codex",
      onChange: onProvider,
      hasMultiple: true,
    },
    model: {
      active: null,
      selected: "gpt-5",
      options: [
        { value: "gpt-5", label: "GPT-5" },
        { value: "gpt-5-mini", label: "GPT-5 mini" },
      ],
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      loadError: null,
      onChange: onModel,
    },
    reasoning: {
      value: "medium",
      options: [
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
      onChange: onReasoning,
    },
    ...overrides,
  };
  return { value, onProvider, onModel, onReasoning };
}

function renderControls(value: ExecutionControlsProps) {
  const { wrapper } = createQueryClientTestHarness();
  return render(<ExecutionControls {...value} />, { wrapper });
}

function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Provider, model and reasoning" }),
  );
}

beforeAll(() => ModelReasoningMenu.preload());

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("[sma:d_orch_settings] the conversation's own model and reasoning are shown on the control, and choosing another model sends that model, once", () => {
  const { value, onModel, onReasoning, onProvider } = props();
  renderControls(value);
  const trigger = screen.getByRole("button", {
    name: "Provider, model and reasoning",
  });
  expect(trigger.textContent).toContain("GPT-5");
  expect(trigger.textContent).toContain("Medium");

  open();
  fireEvent.click(screen.getByText("GPT-5 mini"));

  expect(onModel).toHaveBeenCalledTimes(1);
  expect(onModel).toHaveBeenCalledWith("gpt-5-mini");
  expect(onReasoning).not.toHaveBeenCalled();
  expect(onProvider).not.toHaveBeenCalled();
});

it("[sma:d_orch_settings] choosing another reasoning level sends that level and touches neither the model nor the provider", () => {
  const { value, onModel, onReasoning, onProvider } = props();
  renderControls(value);

  open();
  fireEvent.click(screen.getByText("High"));

  expect(onReasoning).toHaveBeenCalledTimes(1);
  expect(onReasoning).toHaveBeenCalledWith("high");
  expect(onModel).not.toHaveBeenCalled();
  expect(onProvider).not.toHaveBeenCalled();
});

it("[sma:d_orch_settings] the model the agent is really running (active) is what the control shows, ahead of the chosen one", () => {
  const { value } = props();
  renderControls({
    ...value,
    model: { ...value.model, active: { model: "gpt-5-mini" }, selected: "gpt-5" },
  });
  const trigger = screen.getByRole("button", {
    name: "Provider, model and reasoning",
  });
  expect(trigger.textContent).toContain("GPT-5 mini");
});

it("[sma:d_orch_settings] a locked conversation cannot open the control", () => {
  const { value, onModel } = props();
  renderControls({ ...value, disabled: true });
  const trigger = screen.getByRole("button", {
    name: "Provider, model and reasoning",
  }) as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  fireEvent.click(trigger);
  expect(screen.queryByText("GPT-5 mini")).toBeNull();
  expect(onModel).not.toHaveBeenCalled();
});
