// @vitest-environment jsdom

import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/components/ui/app-toast", () => ({ appToast: toasts }));

import { HttpError } from "@/lib/api";
import { createAppQueryClient } from "./query-client";

function observe(
  queryClient: ReturnType<typeof createAppQueryClient>,
  queryKey: string[],
  queryFn: () => Promise<string>,
) {
  const observer = new QueryObserver(queryClient, { queryKey, queryFn });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("[sma:m_ws_query_client] every window read goes through one client", () => {
  it("[sma:m_ws_query_client] a read that fails on a dropped connection is retried twice, and succeeds on the third try", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue("loaded");
    const { observer, unsubscribe } = observe(queryClient, ["flaky"], queryFn);

    await vi.waitFor(
      () => expect(observer.getCurrentResult().data).toBe("loaded"),
      { timeout: 4_000 },
    );
    expect(queryFn).toHaveBeenCalledTimes(3);
    expect(observer.getCurrentResult().isError).toBe(false);
    unsubscribe();
    queryClient.clear();
  });

  it("[sma:m_ws_query_client] a connection that stays down is tried three times in all, then the read fails", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const { observer, unsubscribe } = observe(queryClient, ["down"], queryFn);

    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true), {
      timeout: 4_000,
    });
    expect(queryFn).toHaveBeenCalledTimes(3);
    unsubscribe();
    queryClient.clear();
  });

  it("[sma:m_ws_query_client] an answer from the server, even a refusal, is not retried", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new HttpError({ status: 401, message: "unauthorized" }));
    const { observer, unsubscribe } = observe(queryClient, ["refused"], queryFn);

    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
    queryClient.clear();
  });

  it("[sma:m_ws_query_client] a second screen asking for the same read within two seconds is served from the cache; no second request goes out", async () => {
    const queryClient = createAppQueryClient();
    const queryFn = vi.fn<() => Promise<string>>().mockResolvedValue("one");
    const first = observe(queryClient, ["shared"], queryFn);
    await vi.waitFor(() => expect(first.observer.getCurrentResult().data).toBe("one"));

    const second = observe(queryClient, ["shared"], queryFn);
    expect(second.observer.getCurrentResult().data).toBe("one");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryFn).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    second.unsubscribe();
    queryClient.clear();
  });

  it("[sma:m_ws_query_client] a failed write shows one error toast with the write's own message; one that opts out shows none", async () => {
    const queryClient = createAppQueryClient();
    const failing = (meta: Record<string, unknown>) =>
      new MutationObserver(queryClient, {
        mutationFn: async () => {
          throw new Error("nope");
        },
        meta,
      }).mutate();

    await failing({ errorMessage: "Failed to save." }).catch(() => undefined);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    expect(toasts.error.mock.calls[0]![0]).toBe("Failed to save");

    await failing({ showErrorToast: false }).catch(() => undefined);
    expect(toasts.error).toHaveBeenCalledTimes(1);
    queryClient.clear();
  });
});
