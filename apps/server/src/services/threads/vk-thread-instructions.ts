// VK EXPERIMENTAL (thread-instructions): keep the instructions sent to the provider bridge for debugging.
// A failed write is logged and never blocks the start or the turn.
import { recordVkThreadInstructions } from "@bb/db";
import type { LoggedWorkSessionDeps } from "../../types.js";

export function vkRecordThreadInstructions(
  deps: LoggedWorkSessionDeps,
  args: {
    threadId: string;
    kind: "start" | "turn";
    providerId: string;
    model: string;
    instructions: string;
  },
): void {
  try {
    recordVkThreadInstructions(deps.db, args.threadId, args.kind, {
      text: args.instructions,
      capturedAt: Date.now(),
      providerId: args.providerId,
      model: args.model,
    });
  } catch (error) {
    deps.logger.warn(
      { err: error, threadId: args.threadId },
      "VK thread instructions snapshot failed; skipping",
    );
  }
}
