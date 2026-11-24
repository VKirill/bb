// VK EXPERIMENTAL — absent from upstream bb.
import { describe, expect, it, vi } from "vitest";

vi.mock("@bb/db", () => ({ getThread: (_db: unknown, id: string) => (id === "thr_gone" ? null : { id, deletedAt: null, archivedAt: id === "thr_archived" ? 1 : null }) }));
const queued: unknown[] = [];
vi.mock("../../../src/services/threads/parent-system-messages.js", () => ({
  queueParentSystemMessage: async (_deps: unknown, args: unknown) => { queued.push(args); return true; },
}));

const { createVkSystemNoticeMethods, vkInstallSystemNoticeSink } = await import("../../../src/services/plugins/vk-system-notice.js");

describe("experimental_vkSystemNotice", () => {
  it("queues the notice as a titled tool-result-delivered system message and refuses gone threads", async () => {
    const methods = createVkSystemNoticeMethods({ pluginId: "lane-pilot", assertLive: () => undefined });
    await expect(methods.experimental_vkSystemNotice({ threadId: "thr_pm", text: "x" })).rejects.toThrow(/unavailable/);
    vkInstallSystemNoticeSink({ db: {} } as never);
    expect(await methods.experimental_vkSystemNotice({ threadId: "thr_pm", text: "Errand done", label: "Поручение выполнено" })).toBe(true);
    expect(queued).toEqual([{
      input: [{ type: "text", text: "Errand done", mentions: [] }], parentThreadId: "thr_pm", deliveryMode: "queue",
      systemMessageKind: "tool-result-delivered", systemMessageSubject: { kind: "tool-call", toolName: "lane-pilot", suppress: false, label: "Поручение выполнено" },
    }]);
    expect(await methods.experimental_vkSystemNotice({ threadId: "thr_gone", text: "x" })).toBe(false);
    expect(await methods.experimental_vkSystemNotice({ threadId: "thr_archived", text: "x" })).toBe(false);
    await expect(methods.experimental_vkSystemNotice({ threadId: "thr_pm", text: "  " })).rejects.toThrow(/non-empty/);
    expect(queued).toHaveLength(1);
    await methods.experimental_vkSystemNotice({ threadId: "thr_pm", text: "now", mode: "steer" });
    expect((queued[1] as { deliveryMode: string }).deliveryMode).toBe("steer");
    await expect(methods.experimental_vkSystemNotice({ threadId: "thr_pm", text: "x", mode: "later" as never })).rejects.toThrow(/mode/);
  });
});
