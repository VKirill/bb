import { describe, expect, it } from "vitest";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { isVkQuietChildThread, VK_QUIET_CHILD_KEY } from "../../src/data/vk-quiet-child.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { threadPluginMetadata } from "../../src/schema.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "quiet-host", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "quiet", source: { type: "local_path", hostId: host.id, path: "/tmp/quiet" } });
  return { db, project };
}

describe("VK quiet child", () => {
  it("is quiet only when the plugin metadata sets the flag to true", () => {
    const { db, project } = setup();
    const quiet = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "writer", [VK_QUIET_CHILD_KEY]: true } } });
    const loud = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { role: "errand" } } });
    const stringFlag = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex",
      pluginMetadata: { pluginId: "lane-pilot", metadata: { [VK_QUIET_CHILD_KEY]: "true" } } });
    const bare = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    expect(isVkQuietChildThread(db, quiet.id)).toBe(true);
    expect(isVkQuietChildThread(db, loud.id)).toBe(false);
    expect(isVkQuietChildThread(db, stringFlag.id)).toBe(false);
    expect(isVkQuietChildThread(db, bare.id)).toBe(false);
  });

  it("reads a corrupt metadata row as not quiet", () => {
    const { db, project } = setup();
    const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
    db.insert(threadPluginMetadata).values({ threadId: thread.id, pluginId: "broken", metadataJson: "{not json" }).run();
    expect(isVkQuietChildThread(db, thread.id)).toBe(false);
  });
});
