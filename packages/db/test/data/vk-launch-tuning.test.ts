import { describe, expect, it } from "vitest";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { readVkLaunchTuningForThread } from "../../src/data/vk-launch-tuning.js";
import { VK_LAUNCH_TUNING_METADATA_KEY } from "@bb/domain/vk-launch-tuning";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../../src/testing.js";
import { threadPluginMetadata } from "../../src/schema.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "tuning-host", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "tuning", source: { type: "local_path", hostId: host.id, path: "/tmp/tuning" } });
  return { db, project };
}

describe("VK launch tuning", () => {
  it("reads the tuning a plugin put into its metadata on spawn", () => {
    const { db, project } = setup();
    const tuning = { version: 1, acp: { mode: "ask" }, claude: { disallowedTools: ["Edit"] } };
    const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "acp-cursor",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "code-critic", [VK_LAUNCH_TUNING_METADATA_KEY]: tuning } } });
    expect(readVkLaunchTuningForThread(db, thread.id)).toEqual(tuning);
  });

  it("is null for a thread with no metadata, no key, an invalid value or a corrupt row", () => {
    const { db, project } = setup();
    const bare = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    const noKey = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "writer" } } });
    const wrongVersion = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { [VK_LAUNCH_TUNING_METADATA_KEY]: { version: 9, acp: { mode: "ask" } } } } });
    const corrupt = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    db.insert(threadPluginMetadata).values({ threadId: corrupt.id, pluginId: "broken", metadataJson: "{not json" }).run();
    for (const thread of [bare, noKey, wrongVersion, corrupt]) {
      expect(readVkLaunchTuningForThread(db, thread.id)).toBeNull();
    }
  });

  it("skips a broken row and takes the valid one of another plugin", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    db.insert(threadPluginMetadata).values({ threadId: thread.id, pluginId: "a-broken", metadataJson: "[1]" }).run();
    db.insert(threadPluginMetadata).values({ threadId: thread.id, pluginId: "b-good",
      metadataJson: JSON.stringify({ [VK_LAUNCH_TUNING_METADATA_KEY]: { version: 1, acp: { args: ["--sandbox"] } } }) }).run();
    expect(readVkLaunchTuningForThread(db, thread.id)).toEqual({ version: 1, acp: { args: ["--sandbox"] } });
  });
});
