import { describe, expect, it, vi } from "vitest";
import type {
  InstalledPlugin,
  PluginApplyUpdateResult,
  PluginInstallJob,
  PluginUpdateJob,
} from "@bb/server-contract";
import { createPluginInstallJobs } from "../../src/services/plugins/plugin-install-jobs.js";
import { createPluginUpdateJobs } from "../../src/services/plugins/plugin-update-jobs.js";
import { reportPluginUpdatePhase } from "../../src/services/plugins/plugin-update-progress.js";

const version = (value: string) => ({ version: value, label: value, display: `matrix@${value}` });

describe("update jobs: one run of the installer, reported (core: plugin-update-jobs)", () => {
  it("[sma:k_v_update] an update starts the installer run once and reports its outcome: running with its phase, then the version it moved from and to; a failure is its message", async () => {
    const seen: PluginUpdateJob[] = [];
    let jobs!: ReturnType<typeof createPluginUpdateJobs>;
    jobs = createPluginUpdateJobs({
      notifyChanged: () => {
        for (const job of jobs.list()) seen.push(job);
      },
    });
    const run = vi.fn(async (): Promise<PluginApplyUpdateResult> => {
      reportPluginUpdatePhase("activating");
      return { applied: true, from: version("1.0.0"), to: version("1.2.0"), outcome: "updated" };
    });
    const started = jobs.start({ pluginId: "matrix", displayName: "Matrix", run });
    // started means requested: the run is picked up at once, never twice
    expect(run).toHaveBeenCalledTimes(1);
    expect(started).toMatchObject({ pluginId: "matrix", displayName: "Matrix" });
    const done = await jobs.settled(started.id);
    expect(done).toEqual({
      id: started.id,
      pluginId: "matrix",
      displayName: "Matrix",
      state: "completed",
      result: { applied: true, from: version("1.0.0"), to: version("1.2.0"), outcome: "updated" },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(seen.map((job) => (job.state === "running" ? `running:${job.phase}` : job.state))).toEqual(
      expect.arrayContaining(["queued", "running:preparing", "running:activating", "completed"]),
    );

    const failing = jobs.start({
      pluginId: "other",
      displayName: "Other",
      run: async () => {
        throw new Error("registry returned 404");
      },
    });
    expect(await jobs.settled(failing.id)).toEqual({
      id: failing.id,
      pluginId: "other",
      displayName: "Other",
      state: "failed",
      error: "registry returned 404",
    });
    // a finished job stays listed for the report
    expect(jobs.list().map((job) => job.state)).toEqual(["completed", "failed"]);
  });
});

describe("install jobs: what was installed, reported (core: plugin-install-jobs)", () => {
  const plugin = { id: "matrix", name: "Matrix", version: "1.2.0" } as unknown as InstalledPlugin;
  const target = { kind: "source" as const, source: "npm:bb-plugin-matrix", selection: { kind: "root" as const } };

  it("[sma:k_in_done] a finished install reports the plugin that was installed; a failed one reports why; both stay listed", async () => {
    const jobs = createPluginInstallJobs({ notifyChanged: () => {} });
    const ok = jobs.start({ target, displayName: "Matrix", run: async () => plugin });
    const bad = jobs.start({
      target: { ...target, source: "npm:bb-plugin-broken" },
      displayName: "Broken",
      run: async () => {
        throw new Error("package has no bb manifest");
      },
    });
    expect((await jobs.settled(ok.id)) as PluginInstallJob).toEqual({
      id: ok.id,
      target,
      displayName: "Matrix",
      state: "succeeded",
      plugin,
    });
    expect((await jobs.settled(bad.id)) as PluginInstallJob).toEqual({
      id: bad.id,
      target: { ...target, source: "npm:bb-plugin-broken" },
      displayName: "Broken",
      state: "failed",
      error: "package has no bb manifest",
    });
    expect(jobs.list().map((job) => [job.displayName, job.state])).toEqual([
      ["Matrix", "succeeded"],
      ["Broken", "failed"],
    ]);
    // a repeat request while one is active is folded into it; the report is of the one install
    let release!: (value: InstalledPlugin) => void;
    const first = jobs.start({
      target: { ...target, source: "npm:bb-plugin-slow" },
      displayName: "Slow",
      run: () => new Promise<InstalledPlugin>((resolve) => (release = resolve)),
    });
    const again = jobs.start({
      target: { ...target, source: "npm:bb-plugin-slow" },
      displayName: "Slow",
      run: async () => plugin,
    });
    expect(again.id).toBe(first.id);
    await vi.waitFor(() => expect(jobs.get(first.id)?.state).toBe("running"));
    release(plugin);
    expect(await jobs.settled(first.id)).toMatchObject({ state: "succeeded", plugin });
  });
});
