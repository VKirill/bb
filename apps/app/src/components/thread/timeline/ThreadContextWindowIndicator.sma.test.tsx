// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ThreadContextWindowUsage } from "@bb/server-contract";
import { afterEach, expect, it } from "vitest";
import {
  ThreadContextWindowCard,
  ThreadContextWindowIndicator,
} from "./ThreadContextWindowIndicator";

afterEach(cleanup);

const WINDOW = 200_000;

function usage(
  usedTokens: number,
  extra: Partial<ThreadContextWindowUsage> = {},
): ThreadContextWindowUsage {
  return { usedTokens, modelContextWindow: WINDOW, estimated: false, ...extra };
}

function card(u: ThreadContextWindowUsage) {
  render(<ThreadContextWindowCard usage={u} />);
  return {
    used: screen.getByText(/% used$/u),
    left: screen.getByText(/% left$/u),
    tokens: screen.getByText(/tokens$/u),
  };
}

it("[sma:m_sw_context_notice] the card says how full the window is: percent used, tokens used of the window, percent left", () => {
  const view = card(usage(110_000));
  expect(view.used.textContent).toBe("55% used");
  expect(view.tokens.textContent).toBe("110k / 200k tokens");
  expect(view.left.textContent).toBe("45% left");
  expect(screen.getByText("Context window")).toBeDefined();
  expect(screen.queryByText("Session cost")).toBeNull();
});

it("[sma:m_sw_context_notice] the fill turns to a warning from 75% and to an alarm from 90%, and stays calm below", () => {
  const tone = (used: number) => {
    const { used: label } = card(usage(used));
    const className = label.className;
    cleanup();
    return className;
  };
  expect(tone(110_000)).toContain("text-muted-foreground");
  expect(tone(150_000)).toContain("text-warning-text"); // 75%
  expect(tone(160_000)).toContain("text-warning-text"); // 80%
  expect(tone(166_000)).toContain("text-warning-text"); // 83%
  expect(tone(180_000)).toContain("text-destructive"); // 90%
  expect(tone(192_000)).toContain("text-destructive"); // 96%
  expect(tone(148_000)).toContain("text-muted-foreground"); // 74%
});

it("[sma:m_sw_context_notice] an estimate is labelled «Estimated context», an over-full window reads 100% used and 0% left, and a session cost is shown when known", () => {
  const view = card(
    usage(250_000, { estimated: true, cost: { amount: 1.5, currency: "USD" } }),
  );
  expect(screen.getByText("Estimated context")).toBeDefined();
  expect(screen.queryByText("Context window")).toBeNull();
  expect(view.used.textContent).toBe("100% used");
  expect(view.left.textContent).toBe("0% left");
  expect(screen.getByText("Session cost")).toBeDefined();
  expect(screen.getByText("Session cost").nextElementSibling?.textContent).toBe(
    "$1.50",
  );
});

it("[sma:m_sw_context_notice] the round indicator in the composer is named by the same percentage", () => {
  render(<ThreadContextWindowIndicator usage={usage(36_000)} />);
  expect(
    screen.getByRole("button", { name: "Context window 18% used" }),
  ).toBeDefined();
  cleanup();
  render(<ThreadContextWindowIndicator usage={usage(192_000)} />);
  expect(
    screen.getByRole("button", { name: "Context window 96% used" }),
  ).toBeDefined();
});
