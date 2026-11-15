import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "./fixtures.js";
import {
  buildProjectThreadGroups,
  isSidebarProjectThread,
  type ProjectThreadItem,
} from "./project-thread-groups.js";
import { experimental_resolveThreadStatus } from "@get-bb/plugin-sdk/app";
import { buildSidebarData } from "./use-sidebar-data.js";

function ids(items: readonly ProjectThreadItem[]): string[] {
  return items.map((item) =>
    item.kind === "thread" ? item.node.thread.id : `(${item.kind})`,
  );
}

describe("[sma:d_chat_conv] the list of a project's conversations", () => {
  it("[sma:d_chat_conv] holds the project's own threads only, and leaves out a hidden one", () => {
    const projects = [
      {
        id: "proj_a",
        name: "A",
        isPersonal: false,
        href: "/projects/proj_a",
        settingsHref: "/projects/proj_a/settings",
      },
      {
        id: "proj_b",
        name: "B",
        isPersonal: false,
        href: "/projects/proj_b",
        settingsHref: "/projects/proj_b/settings",
      },
    ];
    const data = buildSidebarData(
      "ready",
      [
        makeSidebarThread({ id: "a1", projectId: "proj_a" }),
        makeSidebarThread({ id: "b1", projectId: "proj_b" }),
        makeSidebarThread({ id: "a2", projectId: "proj_a", isHidden: true }),
        makeSidebarThread({ id: "a3", projectId: "proj_a" }),
      ],
      projects,
      [],
    );

    const alpha = data.projects.find((project) => project.id === "proj_a")!;
    expect(alpha.threads.map((thread) => thread.id)).toEqual(["a1", "a2", "a3"]);
    expect(ids(buildProjectThreadGroups(alpha.threads)).sort()).toEqual([
      "a1",
      "a3",
    ]);
    expect(isSidebarProjectThread({ isHidden: true })).toBe(false);
    expect(
      data.projects.find((project) => project.id === "proj_b")!.threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["b1"]);
  });

  it("[sma:d_chat_conv] lists the running conversations first (newest started first), then the rest by latest attention, children under their parent", () => {
    const items = buildProjectThreadGroups([
      makeSidebarThread({
        id: "old-idle",
        status: "idle",
        createdAt: 1,
        latestAttentionAt: 10,
      }),
      makeSidebarThread({
        id: "fresh-idle",
        status: "idle",
        createdAt: 2,
        latestAttentionAt: 50,
      }),
      makeSidebarThread({
        id: "run-early",
        status: "active",
        runtimeStatus: "active",
        createdAt: 3,
        latestAttentionAt: 5,
      }),
      makeSidebarThread({
        id: "run-late",
        status: "active",
        runtimeStatus: "active",
        createdAt: 9,
        latestAttentionAt: 6,
      }),
      makeSidebarThread({
        id: "child-of-old",
        status: "idle",
        parentThreadId: "old-idle",
        createdAt: 4,
        latestAttentionAt: 99,
      }),
    ]);

    expect(ids(items)).toEqual(["run-late", "run-early", "fresh-idle", "old-idle"]);
    const parent = items.find(
      (item) => item.kind === "thread" && item.node.thread.id === "old-idle",
    );
    expect(
      parent?.kind === "thread"
        ? parent.node.children.map((child) =>
            child.kind === "thread" ? child.node.thread.id : child.kind,
          )
        : null,
    ).toEqual(["child-of-old"]);
  });
});

describe("[sma:m_sw_conv_list] running conversations are marked in the project's list", () => {
  function markOf(overrides: Parameters<typeof makeSidebarThread>[0]) {
    const thread = makeSidebarThread({
      lastReadAt: 100,
      latestAttentionAt: 100,
      ...overrides,
    });
    const status = experimental_resolveThreadStatus({
      thread,
      hiddenThreads: [],
      hasUnsubmittedDraft: false,
      rowStatus: null,
    });
    return { kind: status.indicator, label: status.label };
  }

  it("[sma:m_sw_conv_list] a thread whose agent works is marked «Thread working»; an idle one has no mark", () => {
    expect(markOf({ status: "active", runtimeStatus: "active" })).toEqual({
      kind: "runtime",
      label: "Thread working",
    });
    expect(markOf({ status: "idle", runtimeStatus: "idle" })).toEqual({
      kind: "none",
      label: null,
    });
  });

  it("[sma:m_sw_conv_list] a thread that is starting, provisioning or stopping still counts as running; one in error or waiting for a host does not", () => {
    for (const runtimeStatus of ["starting", "provisioning", "stopping"] as const) {
      expect(markOf({ status: "active", runtimeStatus }).kind).toBe("runtime");
    }
    for (const runtimeStatus of ["error", "waiting-for-host", "pending"] as const) {
      expect(markOf({ status: "idle", runtimeStatus }).kind).toBe("none");
    }
  });

  it("[sma:m_sw_conv_list] a question waiting for the person is marked over the running mark", () => {
    expect(
      markOf({
        status: "active",
        runtimeStatus: "active",
        hasPendingInteraction: true,
      }),
    ).toEqual({ kind: "waiting-for-input", label: "Thread needs user input" });
  });
});
