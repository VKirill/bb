// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComposerView } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetPluginComposerActionUsageForTest } from "@/lib/plugin-composer-action-usage";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { ComposerActionsSlot } from "./PluginComposerActions";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import {
  PluginComposerHostProvider,
  type PluginComposerHost,
} from "./plugin-composer-host";

// VK EXPERIMENTAL: a plugin the place's session policy leaves out shows no
// composer UI there.

const view = (threadId: string): ComposerView => ({
  scope: { kind: "thread", threadId },
  layout: "expanded",
  draft: { text: "", isEmpty: true, attachmentCount: 0 },
  run: { isRunning: false, isSubmitting: false },
});

const host = (threadId: string) =>
  ({
    scope: { kind: "thread", threadId },
    textEffectKey: "k",
    getCurrent: () => ({ text: "" }),
    subscribeDraft: () => () => {},
    setDraft: () => {},
    focus: () => {},
  }) as unknown as PluginComposerHost;

function registerPlugin(pluginId: string): void {
  setPluginSlotRegistrations(
    pluginId,
    makePluginRegistrationSet({
      composerCustomizations: [
        {
          id: "tools",
          actions: [
            {
              id: "action",
              component: () => <button type="button">{pluginId}</button>,
            },
          ],
        },
      ],
    }),
  );
}

describe("vk composer exclusion", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPluginComposerActionUsageForTest();
    resetPluginSlotStoreForTest();
    resetAllCrashedPluginSlotsForTest();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides the composer actions of a plugin the place leaves out", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, pluginIds: ["agency"] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    registerPlugin("agency");
    registerPlugin("lane-pilot");
    render(
      <PluginComposerHostProvider value={host("thr_vk")}>
        <ComposerActionsSlot view={view("thr_vk")} />
      </PluginComposerHostProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "agency" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "lane-pilot" })).toBeDefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("threadId=thr_vk");
  });

  it("keeps every plugin when the place excludes nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ ok: true, pluginIds: [] })),
      ),
    );
    registerPlugin("agency");
    registerPlugin("lane-pilot");
    render(
      <PluginComposerHostProvider value={host("thr_vk_none")}>
        <ComposerActionsSlot view={view("thr_vk_none")} />
      </PluginComposerHostProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "agency" })).toBeDefined(),
    );
    expect(screen.getByRole("button", { name: "lane-pilot" })).toBeDefined();
  });
});
