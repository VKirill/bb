import { describe, expect, it } from "vitest";
import { THREAD_LIFECYCLE } from "../src/thread-lifecycle.js";

// 0.50 (#7561): evaluateThreadLifecycleEvent left @bb/domain for the server's
// lifecycle machine; THREAD_LIFECYCLE stays here as the status sub-table it
// consults, so the proof reads the same transitions from the table.
describe("thread lifecycle (SMA proofs)", () => {
  it("[sma:m_cb_turn_registry] a stop that arrives before the turn has started is remembered: the thread waits in stopping, a late start does not make it active, and it settles to idle", () => {
    expect(THREAD_LIFECYCLE.starting["stop.requested"]).toBe("stopping");
    expect(THREAD_LIFECYCLE.stopping["run.started"]).toBeUndefined();
    expect(THREAD_LIFECYCLE.stopping["stop.settled"]).toBe("idle");
  });
});
