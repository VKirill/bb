import type { ThreadListEntry } from "@bb/domain";
import type {
  ThreadSearchMatch,
  ThreadSearchResponse,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { buildPaletteThreadSearchRows } from "./palette-thread-search";

const NOW = 1_000_000;

function makeThread(
  id: string,
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return {
    id,
    projectId: "project-1",
    environmentId: null,
    providerId: "codex",
    title: `Title ${id}`,
    titleFallback: `Fallback ${id}`,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    parentNotifications: "auto",
    archivedAt: null,
    pinnedAt: null,
    pinSortKey: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: NOW,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: { displayStatus: "idle" },
    queuedWork: "none",
    ...overrides,
  };
}

const snippet = (text: string): ThreadSearchMatch => ({
  sourceKind: "user_message",
  text,
  highlightRanges: [{ start: 0, end: 4 }],
  sourceSeq: 7,
});

function build(
  searchResponse: ThreadSearchResponse,
  overrides: Partial<Parameters<typeof buildPaletteThreadSearchRows>[0]> = {},
) {
  return buildPaletteThreadSearchRows({
    lifecycles: ["active"],
    now: NOW,
    projectNamesById: new Map([["project-1", "Palette project"]]),
    query: "migration",
    recentThreads: [],
    searchResponse,
    searchResultsAreCurrent: true,
    sort: "relevance",
    sortDirection: "descending",
    ...overrides,
  });
}

const EMPTY = { total: 0, results: [] };

describe("[sma:m_sw_search] the search answer keeps the server's order and the window only groups it", () => {
  it("[sma:m_sw_search] rows whose message matched keep the order the server ranked them in; a thread whose title matches is put first", () => {
    const rows = build({
      active: {
        total: 3,
        results: [
          {
            thread: makeThread("zeta", { title: "Zeta notes" }),
            matches: [snippet("migration steps")],
          },
          {
            thread: makeThread("alpha", { title: "Alpha notes" }),
            matches: [snippet("migration order")],
          },
          {
            thread: makeThread("plan", { title: "Migration plan" }),
            matches: [],
          },
        ],
      },
      archived: EMPTY,
    }).rows;

    expect(rows.map((row) => row.threadId)).toEqual(["plan", "zeta", "alpha"]);
    expect(rows.find((row) => row.threadId === "zeta")?.excerpt?.text).toBe(
      "migration steps",
    );
    expect(rows.find((row) => row.threadId === "zeta")?.messageSeq).toBe(7);
  });

  it("[sma:m_sw_search] the same thread answered in both groups stays in each, under its own group, with its own row id", () => {
    const thread = makeThread("both", { title: "Migration both" });
    const archived = makeThread("both", {
      title: "Migration both",
      archivedAt: NOW - 1,
    });
    const rows = build(
      {
        active: { total: 1, results: [{ thread, matches: [] }] },
        archived: { total: 1, results: [{ thread: archived, matches: [] }] },
      },
      { lifecycles: ["active", "archived"] },
    ).rows;

    expect(rows.map((row) => [row.lifecycle, row.id])).toEqual([
      ["active", "active:both"],
      ["archived", "archived:both"],
    ]);
  });

  it("[sma:m_sw_search] an answer for an older query is not shown, and a query shorter than two letters asks nothing of the server", () => {
    const response: ThreadSearchResponse = {
      active: {
        total: 1,
        results: [
          { thread: makeThread("old", { title: "Migration old" }), matches: [] },
        ],
      },
      archived: EMPTY,
    };
    expect(build(response, { searchResultsAreCurrent: false }).rows).toEqual([]);
    expect(build(response, { query: "m" }).rows).toEqual([]);
  });

  it("[sma:m_sw_search] when the person asks for a date order the rows are sorted by that date, newest first and reversible", () => {
    const response: ThreadSearchResponse = {
      active: {
        total: 3,
        results: [
          { thread: makeThread("mid", { title: "Migration mid", updatedAt: 20 }), matches: [] },
          { thread: makeThread("new", { title: "Migration new", updatedAt: 30 }), matches: [] },
          { thread: makeThread("old", { title: "Migration old", updatedAt: 10 }), matches: [] },
        ],
      },
      archived: EMPTY,
    };
    expect(
      build(response, { sort: "updated" }).rows.map((row) => row.threadId),
    ).toEqual(["new", "mid", "old"]);
    expect(
      build(response, { sort: "updated", sortDirection: "ascending" }).rows.map(
        (row) => row.threadId,
      ),
    ).toEqual(["old", "mid", "new"]);
  });
});
