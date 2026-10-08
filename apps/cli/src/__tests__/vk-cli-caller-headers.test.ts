import { afterEach, describe, expect, it, vi } from "vitest";
import { cliFetch } from "../client.js";

// VK EXPERIMENTAL: the server marks plugin rpc/CLI calls by these headers (vk-rpc-caller.ts).
describe("VK cliFetch caller headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function sentHeaders(): Promise<Headers> {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await cliFetch("http://127.0.0.1:1/x", { headers: { "x-keep": "1" } });
    return new Headers(
      (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers,
    );
  }

  it("says plain cli outside an agent session and keeps other headers", async () => {
    vi.stubEnv("BB_VK_THREAD_TOKEN", "");
    vi.stubEnv("BB_THREAD_ID", "");
    const headers = await sentHeaders();
    expect(headers.get("x-bb-vk-client")).toBe("cli");
    expect(headers.get("x-bb-vk-thread-token")).toBeNull();
    expect(headers.get("x-keep")).toBe("1");
  });

  it("sends the thread token inside a session", async () => {
    vi.stubEnv("BB_VK_THREAD_TOKEN", "vkt1.thr_a.sig");
    vi.stubEnv("BB_THREAD_ID", "thr_a");
    const headers = await sentHeaders();
    expect(headers.get("x-bb-vk-thread-token")).toBe("vkt1.thr_a.sig");
    expect(headers.get("x-bb-vk-client")).toBe("cli-in-thread");
  });

  it("flags a session that has a thread id but no token", async () => {
    vi.stubEnv("BB_VK_THREAD_TOKEN", "");
    vi.stubEnv("BB_THREAD_ID", "thr_a");
    const headers = await sentHeaders();
    expect(headers.get("x-bb-vk-thread-token")).toBeNull();
    expect(headers.get("x-bb-vk-client")).toBe("cli-in-thread");
  });
});
