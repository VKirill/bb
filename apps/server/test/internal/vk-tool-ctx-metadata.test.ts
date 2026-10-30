import { createThread, insertThreadPluginMetadata, noopNotifier } from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";

import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { vkToolContextPluginMetadata } from "../../src/internal/vk-tool-ctx-metadata.js";

describe("vkToolContextPluginMetadata", () => {
  it("returns the calling plugin's own metadata for the thread, null without a row and never another plugin's", () => {
    const db = createMigratedConnection();
    const thread = createThread(db, noopNotifier, { projectId: PERSONAL_PROJECT_ID, providerId: "codex" });
    insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "lane-pilot",
      metadata: { role: "writer", lanePilotRunId: "run_9" },
    });
    insertThreadPluginMetadata(db, {
      threadId: thread.id,
      pluginId: "other-plugin",
      metadata: { other: true },
    });
    const deps = { db } as never;
    expect(vkToolContextPluginMetadata(deps, { threadId: thread.id, pluginId: "lane-pilot" }))
      .toEqual({ role: "writer", lanePilotRunId: "run_9" });
    expect(vkToolContextPluginMetadata(deps, { threadId: thread.id, pluginId: "no-rows" })).toBeNull();
    expect(vkToolContextPluginMetadata(deps, { threadId: "thr_none", pluginId: "lane-pilot" })).toBeNull();
  });
});
