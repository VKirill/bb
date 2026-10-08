import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import {
  CALLER_THREAD_HEADER_NAME,
  CLI_REQUEST_HEADER_NAME,
} from "@bb/config/app-surface";
import type { Dispatcher } from "undici";
import { resolveContextThreadId } from "./context-env.js";

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

// VK EXPERIMENTAL: tell the server who is calling (see vk-rpc-caller.ts on the server).
// Inside an agent session BB_VK_THREAD_TOKEN is set by core; the CLI sends it as a header.
function withVkCallerHeaders(init?: CliRequestInit): CliRequestInit {
  const headers = new Headers(init?.headers);
  const token = process.env.BB_VK_THREAD_TOKEN;
  if (token) headers.set("x-bb-vk-thread-token", token);
  headers.set(
    "x-bb-vk-client",
    token || process.env.BB_THREAD_ID ? "cli-in-thread" : "cli",
  );
  return { ...init, headers };
}

export function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, withVkCallerHeaders(init));
}

function cliSdkFetch(timeoutMs: number | undefined): typeof cliFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(CLI_REQUEST_HEADER_NAME, "1");
    const callerThreadId = resolveContextThreadId();
    if (callerThreadId !== undefined) {
      headers.set(CALLER_THREAD_HEADER_NAME, callerThreadId);
    }
    if (timeoutMs === undefined) return cliFetch(input, { ...init, headers });
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return cliFetch(input, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([init.signal, timeoutSignal])
        : timeoutSignal,
    });
  };
}

export function createCliBbSdk(baseUrl: string, timeoutMs?: number): BbSdk {
  return createNodeBbSdk({ baseUrl, fetch: cliSdkFetch(timeoutMs) });
}
