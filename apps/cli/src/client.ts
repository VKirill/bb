import { createNodeBbSdk, type BbSdk } from "@bb/sdk/node";
import type { Dispatcher } from "undici";
import { isOwnerSignedRequest, ownerSignatureHeaders } from "./vk-owner-key.js"; // VK EXPERIMENTAL

type CliRequestInit = RequestInit & { dispatcher?: Dispatcher };

// VK EXPERIMENTAL: tell the server who is calling (see vk-rpc-caller.ts on the server).
// Inside an agent session BB_VK_THREAD_TOKEN is set by core; the CLI sends it as a header.
// Outside a session the CLI signs owner-relevant requests with the paired owner key
// (vk-owner-key.ts); the hub verifies the signature only when owner login is enabled.
async function requestBodyBytes(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<{ bytes: Uint8Array | undefined; known: boolean }> {
  const body = init?.body;
  if (body === undefined || body === null) {
    if (input instanceof Request && init?.body === undefined) {
      return {
        bytes: new Uint8Array(await input.clone().arrayBuffer()),
        known: true,
      };
    }
    return { bytes: undefined, known: true };
  }
  if (typeof body === "string") {
    return { bytes: new TextEncoder().encode(body), known: true };
  }
  if (body instanceof Uint8Array) return { bytes: body, known: true };
  if (body instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(body), known: true };
  }
  if (body instanceof URLSearchParams) {
    return { bytes: new TextEncoder().encode(body.toString()), known: true };
  }
  return { bytes: undefined, known: false };
}

async function withVkCallerHeaders(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<CliRequestInit> {
  const headers = new Headers(init?.headers);
  const token = process.env.BB_VK_THREAD_TOKEN;
  if (token) headers.set("x-bb-vk-thread-token", token);
  headers.set(
    "x-bb-vk-client",
    token || process.env.BB_THREAD_ID ? "cli-in-thread" : "cli",
  );
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const rawUrl =
    typeof input === "string" || input instanceof URL ? input : input.url;
  let url: URL | null = null;
  try {
    url = new URL(rawUrl);
  } catch {
    url = null;
  }
  if (url !== null && isOwnerSignedRequest(method, url)) {
    const { bytes, known } = await requestBodyBytes(input, init);
    if (known) {
      const signed = ownerSignatureHeaders({ method, url, body: bytes });
      for (const [name, value] of Object.entries(signed ?? {})) {
        headers.set(name, value);
      }
    }
  }
  return { ...init, headers };
}

export async function cliFetch(
  input: RequestInfo | URL,
  init?: CliRequestInit,
): Promise<Response> {
  return fetch(input, await withVkCallerHeaders(input, init));
}

export function createCliBbSdk(baseUrl: string): BbSdk {
  return createNodeBbSdk({ baseUrl, fetch: cliFetch });
}
