import { describe, expect, it } from "vitest";
import { makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import type { PluginTurnFailedEvent } from "@get-bb/plugin-sdk";
import { UNAVAILABLE_RETRY_BASE_MS, decideRetry } from "./retry-policy.js";

const NOW_MS = Date.parse("2026-11-14T12:00:00.000Z");

function failedTurn(
  errorInfo: PluginTurnFailedEvent["errorInfo"],
  attemptNumber = 1,
): PluginTurnFailedEvent {
  return makeTurnFailedEvent({
    threadId: "thread-crashed",
    requestId: "creq_crashedturn",
    errorInfo,
    rateLimits: null,
    attemptNumber,
  });
}

function decide(failure: PluginTurnFailedEvent) {
  return decideRetry({
    failure,
    availability: { kind: "not-routed" },
    maximumWaitMs: null,
    now: NOW_MS,
    random: 0,
  });
}

describe("retry policy for a turn cut off by a crash", () => {
  it("[sma:m_ce_recover] a turn cut off by a dropped stream or a lost connection is sent again after the backoff, and a turn that failed on its own content is not", () => {
    expect(
      decide(
        failedTurn({
          category: "stream-disconnected",
          providerCode: null,
          httpStatusCode: null,
        }),
      ),
    ).toEqual({
      kind: "retry",
      sendAt: NOW_MS + UNAVAILABLE_RETRY_BASE_MS,
      reason: "Provider unavailable",
    });
    expect(
      decide(
        failedTurn(
          {
            category: "connection-failed",
            providerCode: null,
            httpStatusCode: null,
          },
          2,
        ),
      ),
    ).toEqual({
      kind: "retry",
      sendAt: NOW_MS + UNAVAILABLE_RETRY_BASE_MS * 2,
      reason: "Provider unavailable",
    });
    expect(
      decide(
        failedTurn({
          category: "bad-request",
          providerCode: null,
          httpStatusCode: 400,
        }),
      ),
    ).toEqual({ kind: "decline", reason: "not-retryable" });
  });
});
