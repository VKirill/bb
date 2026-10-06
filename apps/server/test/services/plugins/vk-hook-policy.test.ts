import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEvents } from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { ApiError } from "../../../src/errors.js";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";
import {
  createVkHookPolicyApi,
  installVkHookPolicy,
  parseVkHookPolicy,
  reportVkHookTimeout,
} from "../../../src/services/plugins/vk-hook-policy.js";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../../src/services/threads/thread-commands.js";
import { textInput } from "../../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

// VK EXPERIMENTAL: vk.hookPolicy time limits and bb.vk.experimental_vkOnHookTimeout.

async function writePlugin(
  dir: string,
  name: string,
  serverSource: string,
  vk?: unknown,
): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      bb: {
        name: "VK hook policy fixture",
        description: "Hook policy plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
      ...(vk === undefined ? {} : { vk }),
    }),
  );
  await writeFile(join(rootDir, "server.ts"), serverSource);
  return rootDir;
}

/** Collects timeout events on globalThis[name] so the test can read them. */
const recordEvents = (name: string) => `
  globalThis[${JSON.stringify(name)}] = [];
  bb.vk.experimental_vkOnHookTimeout((event) => { globalThis[${JSON.stringify(name)}].push(event); });
`;
const events = (name: string): unknown[] =>
  ((globalThis as Record<string, unknown>)[name] as unknown[]) ?? [];

describe("parseVkHookPolicy", () => {
  const warn = vi.fn();
  beforeEach(() => {
    warn.mockClear();
    installVkHookPolicy({ logger: { warn }, db: {}, hub: {} } as never);
  });

  it("keeps valid values and returns undefined for nothing", () => {
    expect(parseVkHookPolicy(undefined)).toBeUndefined();
    expect(parseVkHookPolicy({})).toBeUndefined();
    expect(
      parseVkHookPolicy({
        messageDispatch: { timeoutMs: 20_000 },
        contributeEnv: { timeoutMs: 12_000, required: true },
        mentionResolve: { timeoutMs: 15_000 },
      }),
    ).toEqual({
      messageDispatch: { timeoutMs: 20_000 },
      contributeEnv: { timeoutMs: 12_000, required: true },
      mentionResolve: { timeoutMs: 15_000 },
    });
  });

  it("clamps out-of-range timeouts to 1000..max and warns", () => {
    expect(
      parseVkHookPolicy({
        messageDispatch: { timeoutMs: 500_000 },
        contributeEnv: { timeoutMs: 20_000 },
        mentionResolve: { timeoutMs: 5 },
      }),
    ).toEqual({
      messageDispatch: { timeoutMs: 30_000 },
      contributeEnv: { timeoutMs: 15_000 },
      mentionResolve: { timeoutMs: 1_000 },
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("ignores invalid shapes and unknown keys without throwing", () => {
    expect(parseVkHookPolicy("nope")).toBeUndefined();
    expect(parseVkHookPolicy([1])).toBeUndefined();
    expect(
      parseVkHookPolicy({
        messageDispatch: "slow",
        contributeEnv: { timeoutMs: "12000", required: true },
        mentionResolve: { timeoutMs: Number.NaN },
        other: { timeoutMs: 5000 },
      }),
    ).toBeUndefined();
    expect(
      parseVkHookPolicy({
        contributeEnv: { timeoutMs: 6_000, required: "yes" },
        other: 1,
      }),
    ).toEqual({ contributeEnv: { timeoutMs: 6_000 } });
  });
});

describe("vk.hookPolicy in the plugin manifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bb-vk-hook-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads only hookPolicy from the top-level vk key", async () => {
    const root = await writePlugin(dir, "bb-plugin-manifest-vk", "", {
      hookPolicy: { contributeEnv: { timeoutMs: 9_000, required: true } },
      schedules: [{ anything: true }],
    });
    const manifest = await readPluginManifest(root);
    expect(manifest.vk).toEqual({
      hookPolicy: { contributeEnv: { timeoutMs: 9_000, required: true } },
    });
  });

  it("has no vk field without a policy and does not fail load on a broken one", async () => {
    const plain = await readPluginManifest(
      await writePlugin(dir, "bb-plugin-plain", ""),
    );
    expect(plain.vk).toBeUndefined();
    const broken = await readPluginManifest(
      await writePlugin(dir, "bb-plugin-broken-vk", "", {
        hookPolicy: 42,
      }),
    );
    expect(broken.vk).toBeUndefined();
  });
});

describe("hook policy through the plugin service", () => {
  let harness: TestAppHarness;
  let pluginsDir: string;
  let threadId: string;
  let projectId: string;
  let hostId: string;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    pluginsDir = await mkdtemp(join(tmpdir(), "bb-vk-hook-policy-"));
    const { host } = seedHostSession(harness.deps, { id: "host-vk-hook" });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: join(harness.config.dataDir, "vk-hook-workspace"),
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: "codex",
    });
    threadId = thread.id;
    projectId = project.id;
    hostId = host.id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await harness.pluginService.stop();
    await harness.cleanup();
    await rm(pluginsDir, { recursive: true, force: true });
  });

  const context = () => ({ threadId, projectId, hostId });
  const timeoutRows = () =>
    listEvents(harness.db, { threadId })
      .filter((event) => event.type === "system/error")
      .map((event) => ({
        data: JSON.parse(event.data) as { code?: string; message?: string },
      }))
      .filter((event) => event.data.code === "vk_hook_timeout");
  const slowEnv = `
    export default function plugin(bb) {
      bb.providers.experimental_contributeEnv("PROVIDER", async () => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        return [{ name: "LP_VAR", value: "1", reason: "slow resolver" }];
      });
      EVENTS
    }
  `;

  it("a declared limit lets a 12 s resolver succeed while the stock 5 s limit drops it silently", async () => {
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-declared",
        slowEnv
          .replace("PROVIDER", "codex")
          .replace("EVENTS", recordEvents("vkDeclaredEvents")),
        { hookPolicy: { contributeEnv: { timeoutMs: 15_000 } } },
      ),
    );
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-stock",
        slowEnv
          .replace("PROVIDER", "claude-code")
          .replace("EVENTS", recordEvents("vkStockEvents")),
      ),
    );

    vi.useFakeTimers();
    const declared = harness.pluginService.resolveProviderEnv({
      providerId: "codex",
      context: context(),
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(declared).resolves.toEqual({
      entries: [
        expect.objectContaining({
          name: "LP_VAR",
          source: { plugin: "vk-declared" },
        }),
      ],
    });

    const stock = harness.pluginService.resolveProviderEnv({
      providerId: "claude-code",
      context: context(),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stock).resolves.toEqual({ entries: [] });
    vi.useRealTimers();

    // Stock witness: no row, no callback for a plugin without a policy.
    expect(events("vkStockEvents")).toEqual([]);
    expect(events("vkDeclaredEvents")).toEqual([]);
    expect(timeoutRows()).toEqual([]);
  });

  it("a timeout of a declared env resolver appends a row and calls every callback; other errors do not", async () => {
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-timeout",
        `export default function plugin(bb) {
          ${recordEvents("vkTimeoutEvents")}
          bb.vk.experimental_vkOnHookTimeout(() => { throw new Error("callback boom"); });
          const second = bb.vk.experimental_vkOnHookTimeout(() => { globalThis.vkDisposedCalled = true; });
          second.dispose();
          bb.providers.experimental_contributeEnv("codex", () => new Promise(() => {}));
          bb.providers.experimental_contributeEnv("claude-code", () => { throw new Error("resolver exploded"); });
        }`,
        { hookPolicy: { contributeEnv: { timeoutMs: 1_000 } } },
      ),
    );
    vi.useFakeTimers();
    const timedOut = harness.pluginService.resolveProviderEnv({
      providerId: "codex",
      context: context(),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut).resolves.toEqual({ entries: [] });
    vi.useRealTimers();

    expect(events("vkTimeoutEvents")).toEqual([
      {
        hook: "contributeEnv",
        pluginId: "vk-timeout",
        timeoutMs: 1_000,
        threadId,
        projectId,
        required: false,
      },
    ]);
    expect(
      (globalThis as Record<string, unknown>).vkDisposedCalled,
    ).toBeUndefined();
    const rows = timeoutRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data).toMatchObject({
      code: "vk_hook_timeout",
      message: "plugin vk-timeout did not answer in 1000 ms: env not applied",
    });

    await expect(
      harness.pluginService.resolveProviderEnv({
        providerId: "claude-code",
        context: context(),
      }),
    ).resolves.toEqual({ entries: [] });
    expect(events("vkTimeoutEvents")).toHaveLength(1);
    expect(timeoutRows()).toHaveLength(1);
  });

  it("required: true stops the turn on a timeout and on a resolver error, unless the session policy drops the plugin", async () => {
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-required",
        `export default function plugin(bb) {
          ${recordEvents("vkRequiredEvents")}
          bb.providers.experimental_contributeEnv("codex", () => new Promise(() => {}));
          bb.providers.experimental_contributeEnv("claude-code", () => { throw new Error("resolver exploded"); });
        }`,
        { hookPolicy: { contributeEnv: { timeoutMs: 1_000, required: true } } },
      ),
    );
    vi.useFakeTimers();
    const timedOut = harness.pluginService.resolveProviderEnv({
      providerId: "codex",
      context: context(),
    });
    const timedOutError = timedOut.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = (await timedOutError) as ApiError;
    vi.useRealTimers();
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(503);
    expect(error.body).toMatchObject({
      code: "vk_required_env_unavailable",
      retryable: true,
      details: { pluginId: "vk-required" },
    });
    expect(error.body.message).toContain('Plugin "vk-required"');
    expect(error.body.message).toContain("retry");
    expect(events("vkRequiredEvents")).toEqual([
      expect.objectContaining({ hook: "contributeEnv", required: true }),
    ]);
    expect(timeoutRows()[0]?.data).toMatchObject({
      message:
        "plugin vk-required did not answer in 1000 ms: env required, turn not started",
    });

    await expect(
      harness.pluginService.resolveProviderEnv({
        providerId: "claude-code",
        context: context(),
      }),
    ).rejects.toMatchObject({
      body: { code: "vk_required_env_unavailable" },
    });
    // Not a timeout: no extra callback or row.
    expect(events("vkRequiredEvents")).toHaveLength(1);

    await expect(
      harness.pluginService.resolveProviderEnv({
        providerId: "claude-code",
        context: context(),
        vkPluginAllowed: () => false,
      }),
    ).resolves.toEqual({ entries: [] });
  });

  it("a required failure aborts building the thread start command with a visible error", async () => {
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-required-start",
        `export default function plugin(bb) {
          bb.providers.experimental_contributeEnv("codex", () => { throw new Error("resolver exploded"); });
        }`,
        { hookPolicy: { contributeEnv: { timeoutMs: 1_000, required: true } } },
      ),
    );
    const { thread, project, environment } = (() => {
      const { host } = seedHostSession(harness.deps, { id: "host-vk-start" });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: join(harness.config.dataDir, "vk-start-workspace"),
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });
      return { thread, project, environment };
    })();
    const execution = await buildExecutionOptions(
      harness.deps,
      { model: "gpt-5" },
      { threadId: thread.id },
    );
    await expect(
      buildThreadStartCommand(harness.deps, {
        environment,
        execution,
        fork: null,
        permissionEscalation: "ask",
        input: textInput("hello"),
        projectId: project.id,
        providerId: "codex",
        requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
        syncGeneratedTitle: false,
        thread,
      }),
    ).rejects.toMatchObject({
      status: 503,
      body: { code: "vk_required_env_unavailable" },
    });
  });

  it("mention resolve uses the declared limit; a stock plugin keeps 10 s and stays silent", async () => {
    const mentionSource = (events: string) => `
      export default function plugin(bb) {
        ${events}
        bb.ui.registerMentionProvider({
          id: "slow",
          label: "Slow",
          search: () => [{ id: "one", title: "One" }],
          resolve: () => new Promise((resolve) => setTimeout(() => resolve({ context: "late" }), 12_000)),
        });
      }
    `;
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-mention",
        mentionSource(recordEvents("vkMentionEvents")),
        { hookPolicy: { mentionResolve: { timeoutMs: 15_000 } } },
      ),
    );
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-mention-stock",
        mentionSource(recordEvents("vkMentionStockEvents")),
      ),
    );
    await harness.pluginService.installPath(
      await writePlugin(
        pluginsDir,
        "bb-plugin-vk-mention-short",
        `export default function plugin(bb) {
          ${recordEvents("vkMentionShortEvents")}
          bb.ui.registerMentionProvider({
            id: "slow",
            label: "Slow",
            search: () => [],
            resolve: () => new Promise(() => {}),
          });
        }`,
        { hookPolicy: { mentionResolve: { timeoutMs: 1_000 } } },
      ),
    );

    vi.useFakeTimers();
    const declared = harness.pluginService.resolveMention({
      pluginId: "vk-mention",
      itemId: "slow:one",
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await declared).toMatchObject({ ok: true, context: "late" });

    const stock = harness.pluginService.resolveMention({
      pluginId: "vk-mention-stock",
      itemId: "slow:one",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await stock).toEqual({
      ok: false,
      error: "timed out after 10000ms",
    });

    const short = harness.pluginService.resolveMention({
      pluginId: "vk-mention-short",
      itemId: "slow:one",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await short).toEqual({
      ok: false,
      error: "timed out after 1000ms",
    });
    vi.useRealTimers();

    expect(events("vkMentionEvents")).toEqual([]);
    expect(events("vkMentionStockEvents")).toEqual([]);
    expect(events("vkMentionShortEvents")).toEqual([
      {
        hook: "mentionResolve",
        pluginId: "vk-mention-short",
        timeoutMs: 1_000,
        required: false,
      },
    ]);
  });

  it("reportVkHookTimeout survives a failing timeline append and rejects non-functions in the API", async () => {
    const calls: unknown[] = [];
    const api = createVkHookPolicyApi({
      pluginId: "direct",
      assertLive: () => {},
      onDispose: () => {},
    });
    api.experimental_vkOnHookTimeout((event) => {
      calls.push(event);
    });
    expect(() => api.experimental_vkOnHookTimeout(undefined as never)).toThrow(
      "expects a function",
    );
    await reportVkHookTimeout({
      hook: "messageDispatch",
      pluginId: "direct",
      timeoutMs: 1_000,
      threadId: "thr_missing",
      required: false,
    });
    expect(calls).toHaveLength(1);
  });
});
