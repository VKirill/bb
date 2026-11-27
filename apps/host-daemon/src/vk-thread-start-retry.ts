// VK EXPERIMENTAL (thread-start-retry): see VK_PATCHES.md "Thread start retry".
import { JsonRpcRequestTimeoutError } from "@bb/provider-bridge-protocol/bridge-kit";
import type { CommandDispatchOptions } from "./command-dispatch-support.js";

export const VK_THREAD_START_RETRY_ENV = "BB_VK_THREAD_START_RETRY";
const DEFAULT_RETRIES = 1;
const MAX_RETRIES = 3;

export function vkThreadStartRetriesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[VK_THREAD_START_RETRY_ENV]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, MAX_RETRIES)
    : DEFAULT_RETRIES;
}

export async function vkRetryThreadStartOnTimeout<
  T extends { providerThreadId: string },
>(args: {
  command: { threadId: string; providerId: string; fork?: unknown };
  options: Pick<
    CommandDispatchOptions,
    "eventSink" | "logger" | "vkThreadStartRetries"
  >;
  start: () => Promise<T>;
}): Promise<T> {
  const { command, options } = args;
  const retries = options.vkThreadStartRetries ?? DEFAULT_RETRIES;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await args.start();
      if (attempt > 1) {
        options.eventSink.emit({
          threadId: command.threadId,
          event: {
            type: "provider/warning",
            threadId: command.threadId,
            providerThreadId: result.providerThreadId,
            category: "general",
            summary: `The agent did not open its session in time; BB restarted it (attempt ${attempt}).`,
            scope: { kind: "thread" },
          },
        });
      }
      return result;
    } catch (error) {
      const timedOut =
        error instanceof JsonRpcRequestTimeoutError &&
        error.method === "thread/start";
      if (!timedOut || command.fork || attempt > retries) throw error;
      options.logger.warn(
        {
          threadId: command.threadId,
          providerId: command.providerId,
          attempt: attempt + 1,
        },
        "thread/start timed out; retrying with a fresh session",
      );
    }
  }
}
