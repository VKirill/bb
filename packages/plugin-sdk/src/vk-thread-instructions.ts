/** VK extension (thread-instructions). One instruction text core sent to a thread's provider bridge. */
export interface ExperimentalVkThreadInstructionsSnapshot {
  text: string;
  /** Epoch milliseconds. */
  capturedAt: number;
  providerId: string;
  model: string;
}

export interface ExperimentalVkThreadInstructions {
  /** The text of the latest `thread.start` (a new provider session). */
  start: ExperimentalVkThreadInstructionsSnapshot | null;
  /** The latest turn text that differed from `start`; a resumed session received it. Null when unchanged. */
  latest: ExperimentalVkThreadInstructionsSnapshot | null;
}

/**
 * The optional method VK builds add to `bb.sdk.threads`. Feature-test it:
 * `typeof bb.sdk.threads.experimental_vkThreadInstructions === "function"`.
 * Resolves null when core recorded nothing for the thread (it started before the feature, or the
 * owner turned the feature off). Rejects with `thread_not_found` for a missing or hidden thread.
 */
export interface ExperimentalVkThreadInstructionsMethods {
  experimental_vkThreadInstructions?(
    threadId: string,
  ): Promise<ExperimentalVkThreadInstructions | null>;
}
