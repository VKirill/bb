import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createNpmResolverRun,
  resolveGitUpdate,
  resolveNpmUpdate,
  type GitCandidateProbe,
  type GitSemverTag,
} from "../../src/services/plugins/update-resolver.js";

const execFileAsync = promisify(execFile);

interface Fetched {
  url: string;
  init: RequestInit;
}

function packumentFetch(
  versions: Record<string, { bb?: string; sdk?: string }>,
  tags: Record<string, string>,
  seen: Fetched[] = [],
): typeof fetch {
  return async (input, init) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        versions: Object.fromEntries(
          Object.entries(versions).map(([version, metadata]) => [
            version,
            {
              version,
              engines: {
                ...(metadata.bb ? { bb: metadata.bb } : {}),
                ...(metadata.sdk ? { bbPluginSdk: metadata.sdk } : {}),
              },
              dist: { integrity: `sha512-${version}` },
            },
          ]),
        ),
        "dist-tags": tags,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function intent(requestedSpec: string, specKind: "default" | "exact" | "tag" | "range") {
  return {
    packageName: "bb-plugin-matrix",
    registry: "http://registry.test/",
    requestedSpec,
    specKind,
  } as const;
}

function installed(version: string) {
  return {
    version,
    label: version,
    display: `bb-plugin-matrix@${version}`,
  };
}

describe("plugin update check against the npm registry (core: update-resolver)", () => {
  it("[sma:m_up_verb] the installed version is compared with the registry: newer is offered, the same is current, a pinned exact version is never looked up", async () => {
    const seen: Fetched[] = [];
    const run = createNpmResolverRun({
      fetch: packumentFetch({ "1.0.0": {}, "1.2.0": {} }, { latest: "1.2.0" }, seen),
    });
    const newer = await resolveNpmUpdate({
      intent: intent("", "default"),
      current: installed("1.0.0"),
      appVersion: "1.0.0",
      run,
    });
    expect(newer.outcome).toBe("update-available");
    if (newer.outcome !== "update-available") throw new Error("unreachable");
    expect(newer.current).toEqual(installed("1.0.0"));
    expect(newer.candidate.version).toBe("1.2.0");

    const same = await resolveNpmUpdate({
      intent: intent("", "default"),
      current: installed("1.2.0"),
      appVersion: "1.0.0",
      run,
    });
    expect(same).toEqual({ outcome: "current", current: installed("1.2.0") });

    const before = seen.length;
    const pinned = await resolveNpmUpdate({
      intent: intent("1.0.0", "exact"),
      current: installed("1.0.0"),
      appVersion: "1.0.0",
      run: createNpmResolverRun({ fetch: packumentFetch({}, {}, seen) }),
    });
    expect(pinned).toEqual({ outcome: "pinned", current: installed("1.0.0") });
    expect(seen).toHaveLength(before);
  });

  it("[sma:k_up_report] the report names the installed version and the newest version on the registry, and changes nothing (one read-only GET)", async () => {
    const seen: Fetched[] = [];
    const current = Object.freeze(installed("1.0.0"));
    const resolution = await resolveNpmUpdate({
      intent: intent("", "default"),
      current,
      appVersion: "1.0.0",
      run: createNpmResolverRun({
        fetch: packumentFetch({ "1.0.0": {}, "1.1.0": {}, "1.3.0": {} }, { latest: "1.3.0" }, seen),
      }),
    });
    expect(resolution).toMatchObject({
      outcome: "update-available",
      current: { version: "1.0.0", display: "bb-plugin-matrix@1.0.0" },
      candidate: { version: "1.3.0", label: "1.3.0", display: "bb-plugin-matrix@1.3.0" },
    });
    expect(current).toEqual(installed("1.0.0"));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://registry.test/bb-plugin-matrix");
    expect(seen[0]?.init.method ?? "GET").toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("[sma:k_lib_update] it plans exactly one target: the newest compatible release, with a newer blocked one named beside it", async () => {
    const run = createNpmResolverRun({
      fetch: packumentFetch(
        {
          "1.0.0": {},
          "1.1.0": { bb: ">=0.0.0" },
          "1.2.0": { bb: ">=0.0.0" },
          "1.3.0": { bb: ">=99.0.0" },
        },
        { latest: "1.3.0" },
      ),
    });
    const planned = await resolveNpmUpdate({
      intent: intent("", "default"),
      current: installed("1.0.0"),
      appVersion: "1.0.0",
      run,
    });
    expect(planned.outcome).toBe("update-available");
    if (planned.outcome !== "update-available") throw new Error("unreachable");
    expect(planned.candidate.version).toBe("1.2.0");
    expect(planned.blocked?.version.version).toBe("1.3.0");
    expect(planned.blocked?.reasons.map((reason) => reason.engine)).toEqual(["bb"]);

    // every release newer than the app allows: no target, the newest blocked release is reported
    const none = await resolveNpmUpdate({
      intent: intent("", "default"),
      current: installed("1.0.0"),
      appVersion: "1.0.0",
      run: createNpmResolverRun({
        fetch: packumentFetch({ "1.4.0": { bb: ">=99.0.0" }, "1.5.0": { bb: ">=98.0.0" } }, {}),
      }),
    });
    expect(none.outcome).toBe("incompatible");
    if (none.outcome !== "incompatible") throw new Error("unreachable");
    expect(none.newest.version).toBe("1.5.0");
    expect(none.current).toEqual(installed("1.0.0"));
  });

  it("[sma:k_up_npm] an unreachable registry is a report line, not an error", async () => {
    const refused = await resolveNpmUpdate({
      intent: intent("", "default"),
      current: installed("1.0.0"),
      appVersion: "1.0.0",
      run: createNpmResolverRun({
        fetch: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:4873");
        },
      }),
    });
    expect(refused).toEqual({
      outcome: "unavailable",
      detail: "bb-plugin-matrix registry request failed: connect ECONNREFUSED 127.0.0.1:4873",
    });

    const down = await resolveNpmUpdate({
      intent: intent("", "default"),
      current: installed("1.0.0"),
      appVersion: "1.0.0",
      run: createNpmResolverRun({
        fetch: async () => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }),
      }),
    });
    expect(down).toEqual({
      outcome: "unavailable",
      detail: "bb-plugin-matrix registry request failed: 502 Bad Gateway",
    });

    // one registry answer is shared by a repeat check of the same package
    let calls = 0;
    const run = createNpmResolverRun({
      fetch: async (...args) => {
        calls += 1;
        return packumentFetch({ "1.0.0": {} }, { latest: "1.0.0" })(...args);
      },
    });
    for (let index = 0; index < 2; index += 1) {
      await resolveNpmUpdate({
        intent: intent("", "default"),
        current: installed("1.0.0"),
        appVersion: "1.0.0",
        run,
      });
    }
    expect(calls).toBe(1);
  });
});

describe("plugin update from a git tag range never moves to an older tag (core: update-resolver)", () => {
  let repo = "";
  const commitOf = new Map<string, string>();

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "sma-git-range-"));
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repo });
    for (const tag of ["v1.0.0", "v1.1.0", "v1.2.0", "v2.0.0"]) {
      await writeFile(join(repo, "file.txt"), tag);
      await execFileAsync("git", ["add", "."], { cwd: repo });
      await execFileAsync("git", ["commit", "-qm", tag], { cwd: repo });
      await execFileAsync("git", ["tag", tag], { cwd: repo });
      commitOf.set(tag, (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim());
    }
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function rangeIntent(resolvedTag: string) {
    return { kind: "range", range: "^1.0.0", tagPrefix: "", resolvedTag } as const;
  }

  function recordingProbe(
    verdict: (tag: GitSemverTag) => "compatible" | "incompatible",
    probed: string[],
  ): GitCandidateProbe {
    return async (candidate) => {
      probed.push(candidate.tag);
      return verdict(candidate) === "compatible"
        ? { outcome: "compatible", devMode: false, packagedBuildProblems: [] }
        : {
            outcome: "incompatible",
            devMode: false,
            reasons: [
              { engine: "bb", required: ">=99", actual: "1.0.0", message: `${candidate.tag} needs a newer bb` },
            ],
          };
    };
  }

  it("[sma:k_up_older] at the newest tag of the range the answer is current: the older tags are not even probed, a newer major is not offered", async () => {
    const probed: string[] = [];
    const resolution = await resolveGitUpdate({
      url: repo,
      intent: rangeIntent("v1.2.0"),
      currentCommit: commitOf.get("v1.2.0") as string,
      probeCandidate: recordingProbe(() => "compatible", probed),
    });
    expect(resolution.outcome).toBe("current");
    expect(probed).toEqual([]);
  });

  it("[sma:k_up_older] from an older tag only a newer tag is offered; when the newest tag is blocked the installed one stays and no older tag is chosen", async () => {
    const offered: string[] = [];
    const update = await resolveGitUpdate({
      url: repo,
      intent: rangeIntent("v1.1.0"),
      currentCommit: commitOf.get("v1.1.0") as string,
      probeCandidate: recordingProbe(() => "compatible", offered),
    });
    expect(update).toMatchObject({ outcome: "update-available", candidateGitTag: "v1.2.0" });
    expect(offered).toEqual(["v1.2.0"]);

    const probed: string[] = [];
    const blocked = await resolveGitUpdate({
      url: repo,
      intent: rangeIntent("v1.1.0"),
      currentCommit: commitOf.get("v1.1.0") as string,
      probeCandidate: recordingProbe(() => "incompatible", probed),
    });
    expect(blocked.outcome).toBe("current");
    expect(blocked).not.toHaveProperty("candidate");
    expect(blocked).not.toHaveProperty("candidateGitTag");
    expect(probed).toEqual(["v1.2.0"]);
    if (blocked.outcome !== "current") throw new Error("unreachable");
    expect(blocked.blocked?.reasons[0]?.message).toBe("v1.2.0 needs a newer bb");
  });
});
