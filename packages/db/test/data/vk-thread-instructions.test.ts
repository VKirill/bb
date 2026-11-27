import { describe, expect, it } from "vitest";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  readVkThreadInstructions,
  recordVkThreadInstructions,
  VK_THREAD_INSTRUCTIONS_ROW_ID,
} from "../../src/data/vk-thread-instructions.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../../src/testing.js";
import { threadPluginMetadata } from "../../src/schema.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "ti-host", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "ti", source: { type: "local_path", hostId: host.id, path: "/tmp/ti" } });
  const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "claude-code" });
  return { db, threadId: thread.id };
}

const snap = (text: string, capturedAt = 1) => ({ text, capturedAt, providerId: "claude-code", model: "opus" });

describe("VK thread instructions", () => {
  it("is null before anything is recorded", () => {
    const { db, threadId } = setup();
    expect(readVkThreadInstructions(db, threadId)).toBeNull();
  });

  it("keeps the start text and records a turn only when its text differs", () => {
    const { db, threadId } = setup();
    recordVkThreadInstructions(db, threadId, "start", snap("A", 1));
    recordVkThreadInstructions(db, threadId, "turn", snap("A", 2));
    expect(readVkThreadInstructions(db, threadId)).toEqual({ start: snap("A", 1), latest: null });
    recordVkThreadInstructions(db, threadId, "turn", snap("B", 3));
    recordVkThreadInstructions(db, threadId, "turn", snap("B", 4));
    expect(readVkThreadInstructions(db, threadId)).toEqual({ start: snap("A", 1), latest: snap("B", 3) });
  });

  it("a new start replaces both texts", () => {
    const { db, threadId } = setup();
    recordVkThreadInstructions(db, threadId, "start", snap("A", 1));
    recordVkThreadInstructions(db, threadId, "turn", snap("B", 2));
    recordVkThreadInstructions(db, threadId, "start", snap("C", 3));
    expect(readVkThreadInstructions(db, threadId)).toEqual({ start: snap("C", 3), latest: null });
  });

  it("a turn on a thread that never started is kept as latest", () => {
    const { db, threadId } = setup();
    recordVkThreadInstructions(db, threadId, "turn", snap("T", 5));
    expect(readVkThreadInstructions(db, threadId)).toEqual({ start: null, latest: snap("T", 5) });
  });

  it("reads a corrupt row as null and overwrites it on the next record", () => {
    const { db, threadId } = setup();
    db.insert(threadPluginMetadata).values({ threadId, pluginId: VK_THREAD_INSTRUCTIONS_ROW_ID, metadataJson: "{broken" }).run();
    expect(readVkThreadInstructions(db, threadId)).toBeNull();
    recordVkThreadInstructions(db, threadId, "start", snap("A", 1));
    expect(readVkThreadInstructions(db, threadId)).toEqual({ start: snap("A", 1), latest: null });
  });
});
