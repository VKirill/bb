import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import type { Dispatcher } from "undici";

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

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({ baseUrl, fetch: cliFetch });
}
