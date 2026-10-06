/** VK extension: options of an isolated cron schedule. */
export interface ExperimentalVkScheduleOptions {
  /**
   * Run outside the shared sequential sweep: the sweep starts the schedule
   * without awaiting it, so a slow run does not hold other schedules back.
   */
  isolated?: boolean;
  /** Abort the run after this many ms (default 15 minutes, at most 6 hours). */
  timeoutMs?: number;
  /** A due tick while the previous run is still going is skipped. */
  overlap?: "skip";
}

/** Passed to an isolated schedule function as its first argument. */
export interface ExperimentalVkScheduleContext {
  /** Aborts on timeout, and when the plugin is disposed, reloaded or disabled. */
  readonly signal: AbortSignal;
}

/** The schedule function of `bb.background.experimental_vkSchedule`. */
export type ExperimentalVkScheduleHandler = (
  context: ExperimentalVkScheduleContext,
) => void | Promise<void>;
