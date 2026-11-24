// VK EXPERIMENTAL — absent from upstream bb.
import { describe, expect, it, vi } from "vitest";
import type { ToolCallResponse } from "@bb/domain";
import { PluginToolCallRegistry } from "../../../src/services/plugins/plugin-tool-calls.js";
import { VK_DETACHED_TOOL_CALL_DEFAULT_TEXT, vkDetachToolCall } from "../../../src/services/plugins/vk-detach-tool-call.js";
import { testLogger } from "../../helpers/test-app.js";
import { createDeferredPromise } from "@bb/test-helpers";

const text = (value: string): ToolCallResponse => ({ success: true, contentItems: [{ type: "inputText", text: value }] });

describe("vkDetachToolCall", () => {
  it("answers the model at once and delivers the tool's eventual result as a detached result", async () => {
    const registry = new PluginToolCallRegistry({ logger: testLogger });
    const onDetachedResult = vi.fn(async () => undefined);
    const work = createDeferredPromise<ToolCallResponse>();
    let detached: boolean | undefined;
    const response = registry.run({
      pluginId: "fixture", threadId: "thread", callId: "call", toolName: "errand", roundTrip: new AbortController().signal,
      invoke: async () => { detached = vkDetachToolCall("Started run wfrun_1."); return work.promise; },
      onDetachedResult,
    });
    await expect(response).resolves.toEqual(text("Started run wfrun_1."));
    expect(detached).toBe(true);
    expect(onDetachedResult).not.toHaveBeenCalled();
    work.resolve(text("errand done"));
    await vi.waitFor(() => expect(onDetachedResult).toHaveBeenCalledWith(text("errand done")));
    expect(registry.size).toBe(0);
  });

  it("uses the default notice for an empty text and refuses outside a tool call", async () => {
    expect(vkDetachToolCall("anything")).toBe(false);
    const registry = new PluginToolCallRegistry({ logger: testLogger });
    const response = registry.run({
      pluginId: "fixture", threadId: "thread", callId: "call", toolName: "errand", roundTrip: new AbortController().signal,
      invoke: async () => { vkDetachToolCall("  "); return new Promise<ToolCallResponse>(() => undefined); },
      onDetachedResult: async () => undefined,
    });
    await expect(response).resolves.toEqual(text(VK_DETACHED_TOOL_CALL_DEFAULT_TEXT));
  });
});
