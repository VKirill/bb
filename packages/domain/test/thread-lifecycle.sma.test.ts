import { describe, expect, it } from "vitest";
import { evaluateThreadLifecycleEvent } from "../src/thread-lifecycle.js";
import type { ThreadStatus } from "../src/thread-status.js";

const live = (status: ThreadStatus) => ({
  status,
  archivedAt: null,
  deletedAt: null,
});

describe("thread lifecycle (SMA proofs)", () => {
  it("[sma:m_cb_turn_registry] a stop that arrives before the turn has started is remembered: the thread waits in stopping, a late start does not make it active, and it settles to idle", () => {
    const stopped = evaluateThreadLifecycleEvent({
      event: { type: "stop.requested" },
      thread: live("starting"),
    });
    expect(stopped).toEqual({ to: "stopping" });

    const lateStart = evaluateThreadLifecycleEvent({
      event: { type: "run.started" },
      thread: live("stopping"),
    });
    expect(lateStart).toMatchObject({ noop: "illegal-transition" });

    expect(
      evaluateThreadLifecycleEvent({
        event: { type: "stop.settled" },
        thread: live("stopping"),
      }),
    ).toEqual({ to: "idle" });
  });
});
