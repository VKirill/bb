import { describe, expect, it, vi } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import type { DbNotifier } from "../../src/notifier.js";
import {
  createEnvironment,
  listEnvironments,
} from "../../src/data/environments.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../../src/testing.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "project-one",
    source: { type: "local_path", hostId: host.id, path: "/tmp/sma-one" },
  });
  const { project: other } = createProject(db, noopNotifier, {
    name: "project-two",
    source: { type: "local_path", hostId: host.id, path: "/tmp/sma-two" },
  });
  return { db, host, project, other };
}

describe("workspaces as environments (SMA proofs)", () => {
  it("[sma:k_c_newws] a new workspace is its own fresh environment row on the project and host, provisioning until it is ready, and the world is told it was created", () => {
    const { db, host, project } = setup();
    const notifyEnvironment = vi.fn();
    const notifier = { ...noopNotifier, notifyEnvironment } as DbNotifier;

    const first = createEnvironment(db, notifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/work/copy-a",
      providerOwnsPath: false,
    });
    const second = createEnvironment(db, notifier, {
      projectId: project.id,
      hostId: host.id,
      path: "/work/copy-b",
      providerOwnsPath: false,
      status: "ready",
    });

    expect(first).toMatchObject({
      projectId: project.id,
      hostId: host.id,
      path: "/work/copy-a",
      status: "provisioning",
      providerOwnsPath: false,
    });
    expect(second.status).toBe("ready");
    expect(second.id).not.toBe(first.id);
    expect(notifyEnvironment.mock.calls).toEqual([
      [first.id, ["environment-created"]],
      [second.id, ["environment-created"]],
    ]);
  });

  it("[sma:k_c_listws] workspaces are listed oldest first, narrowed by project and status, and paged", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { db, host, project, other } = setup();
      const make = (
        at: number,
        path: string,
        projectId: string,
        status: "ready" | "provisioning",
      ) => {
        vi.setSystemTime(at);
        return createEnvironment(db, noopNotifier, {
          projectId,
          hostId: host.id,
          path,
          providerOwnsPath: false,
          status,
        });
      };
      const a = make(1_000, "/work/a", project.id, "ready");
      const b = make(2_000, "/work/b", project.id, "provisioning");
      const c = make(3_000, "/work/c", project.id, "ready");
      make(4_000, "/work/other", other.id, "ready");

      expect(
        listEnvironments(db, { projectId: project.id }).map((row) => row.id),
      ).toEqual([a.id, b.id, c.id]);
      expect(
        listEnvironments(db, {
          projectId: project.id,
          statuses: ["ready"],
        }).map((row) => row.id),
      ).toEqual([a.id, c.id]);
      expect(
        listEnvironments(db, { projectId: project.id, limit: 1, offset: 1 }).map(
          (row) => row.id,
        ),
      ).toEqual([b.id]);
      expect(listEnvironments(db, { projectId: other.id })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
