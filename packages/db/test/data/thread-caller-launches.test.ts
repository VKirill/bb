import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createConnection, migrate } from "../../src/index.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  getThreadCallerLaunchByKey,
  isThreadCallerLaunchKeyConstraint,
} from "../../src/data/thread-caller-launches.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";

const LAUNCH = "11111111-1111-4111-8111-111111111111";
const BINDING_A = '{"k":"a"}';
const BINDING_B = '{"k":"b"}';

function seedFileDb() {
  const directory = mkdtempSync(join(tmpdir(), "bb-thread-caller-launches-"));
  const path = join(directory, "db.sqlite");
  const first = createConnection(path);
  migrate(first);
  const host = upsertHost(first, noopNotifier, {
    name: "caller-launch-host",
    type: "persistent",
  });
  const { project } = createProject(first, noopNotifier, {
    name: "caller-launch-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/caller-launch" },
  });
  const second = createConnection(path);
  return { directory, first, project, second };
}

function reserve(bindingJson: string) {
  return {
    originPluginId: "agency",
    callerLaunchId: LAUNCH,
    bindingJson,
  };
}

describe("thread_caller_launches unique key", () => {
  it("rejects a second connection insert for the same origin+launch", () => {
    const { directory, first, project, second } = seedFileDb();
    try {
      const thread = createThread(first, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        callerLaunchReservation: reserve(BINDING_A),
      });
      expect(
        getThreadCallerLaunchByKey(second, {
          originPluginId: "agency",
          callerLaunchId: LAUNCH,
        })?.threadId,
      ).toBe(thread.id);
      let conflict: unknown;
      try {
        createThread(second, noopNotifier, {
          projectId: project.id,
          providerId: "codex",
          callerLaunchReservation: reserve(BINDING_B),
        });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(Error);
      expect(
        isThreadCallerLaunchKeyConstraint(conflict as Error),
      ).toBe(true);
      expect(
        getThreadCallerLaunchByKey(first, {
          originPluginId: "agency",
          callerLaunchId: LAUNCH,
        })?.bindingJson,
      ).toBe(BINDING_A);
    } finally {
      first.$client.close();
      second.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes two connections creating the same key in parallel", async () => {
    const { directory, first, project, second } = seedFileDb();
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          createThread(first, noopNotifier, {
            projectId: project.id,
            providerId: "codex",
            callerLaunchReservation: reserve(BINDING_A),
          }),
        ),
        Promise.resolve().then(() =>
          createThread(second, noopNotifier, {
            projectId: project.id,
            providerId: "codex",
            callerLaunchReservation: reserve(BINDING_A),
          }),
        ),
      ]);
      const fulfilled = results.filter((row) => row.status === "fulfilled");
      const rejected = results.filter((row) => row.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const failure = rejected[0];
      expect(failure?.status).toBe("rejected");
      if (failure?.status === "rejected") {
        expect(failure.reason).toSatisfy(
          (error: unknown) =>
            error instanceof Error && isThreadCallerLaunchKeyConstraint(error),
        );
      }
    } finally {
      first.$client.close();
      second.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
