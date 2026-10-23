import { describe, expect, it } from "vitest";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { vkChildJustToldParent } from "../../src/data/vk-child-told-parent.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../../src/testing.js";
import { events } from "../../src/schema.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "told-host", type: "persistent" });
  const { project } = createProject(db, noopNotifier, { name: "told", source: { type: "local_path", hostId: host.id, path: "/tmp/told" } });
  const parent = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
  const child = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex" });
  let seq = 1000;
  const event = (threadId: string, type: string, at: number, data: Record<string, unknown> = {}) =>
    db.insert(events).values({ id: `ev_${seq}`, threadId, scopeKind: "thread" as never, sequence: seq++, type: type as never, data: JSON.stringify(data), createdAt: at }).run();
  return { db, parent, child, event };
}

describe("VK: a child that just told its parent", () => {
  const now = 10_000_000;
  it("counts a message from the child in the last two minutes of its turn", () => {
    const { db, parent, child, event } = setup();
    event(child.id, "turn/started", now - 600_000);
    event(parent.id, "client/turn/requested", now - 30_000, { senderThreadId: child.id, initiator: "agent" });
    expect(vkChildJustToldParent(db, child.id, parent.id, now)).toBe(true);
  });

  it("does not count a progress note early in the turn, another sender, or a message before this turn", () => {
    const { db, parent, child, event } = setup();
    event(parent.id, "client/turn/requested", now - 900_000, { senderThreadId: child.id });
    event(child.id, "turn/started", now - 600_000);
    event(parent.id, "client/turn/requested", now - 500_000, { senderThreadId: child.id });
    event(parent.id, "client/turn/requested", now - 10_000, { senderThreadId: "thr_other" });
    expect(vkChildJustToldParent(db, child.id, parent.id, now)).toBe(false);
  });
});
