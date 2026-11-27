import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentRuntime } from "@bb/agent-runtime";
import {
  vkRetryThreadStartOnTimeout,
  vkThreadStartRetriesFromEnv,
} from "./vk-thread-start-retry.js";

const acpBridgeModulePath = fileURLToPath(
  new URL(
    "../../../packages/provider-bridge-acp/src/bridge/bridge.ts",
    import.meta.url,
  ),
);
const fakeAgentPath = fileURLToPath(
  new URL(
    "../../../packages/provider-bridge-acp/src/bridge/fake-acp-agent.mjs",
    import.meta.url,
  ),
);

describe("vk thread-start-retry", () => {
  let dir: string | undefined;
  let runtime: ReturnType<typeof createAgentRuntime> | undefined;

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the retry count from BB_VK_THREAD_START_RETRY", () => {
    expect(vkThreadStartRetriesFromEnv({})).toBe(1);
    expect(vkThreadStartRetriesFromEnv({ BB_VK_THREAD_START_RETRY: "0" })).toBe(
      0,
    );
    expect(vkThreadStartRetriesFromEnv({ BB_VK_THREAD_START_RETRY: "9" })).toBe(
      3,
    );
    expect(vkThreadStartRetriesFromEnv({ BB_VK_THREAD_START_RETRY: "x" })).toBe(
      1,
    );
  });

  const setDir = (value: string) => {
    dir = value;
  };

  async function startWithAgentHungOnFirstSession(retries: number) {
    const dir = mkdtempSync(join(tmpdir(), "bb-vk-start-retry-"));
    setDir(dir);
    const hangOncePath = join(dir, "hang-once.mjs");
    writeFileSync(
      hangOncePath,
      `import { existsSync, writeFileSync } from "node:fs";
const mark = ${JSON.stringify(join(dir, "hung"))};
if (!existsSync(mark)) {
  writeFileSync(mark, "1");
  process.env.FAKE_ACP_SESSION_NEW_DELAY_MS = "60000";
}
`,
    );
    runtime = createAgentRuntime({
      workspacePath: dir,
      env: {},
      onEvent: () => {},
      onProcessExit: () => {},
      onToolCall: async () => ({ contentItems: [], success: true }),
      threadCreation: { requestTimeoutMs: 4_000 },
    });
    const bridgeLaunch = {
      pluginId: "provider-acp",
      dataDir: mkdtempSync(join(tmpdir(), "bb-vk-start-retry-data-")),
      source: {
        kind: "artifact" as const,
        digest: "acp-v1",
        artifactPath: acpBridgeModulePath,
      },
      capabilities: {
        providerInstallation: false,
        supportsServiceTier: false,
        permissionModes: ["full" as const],
        supportsThreadArchive: true,
        supportsThreadRename: true,
        fork: "tip" as const,
      },
      providerOptions: {
        acpLaunchSpec: {
          displayName: "Fake ACP",
          command: process.execPath,
          args: ["--import", pathToFileURL(hangOncePath).href, fakeAgentPath],
          env: {},
        },
      },
      envPassthrough: [],
    };
    const started = runtime;
    const emitted: unknown[] = [];
    const warnings: unknown[] = [];
    const result = vkRetryThreadStartOnTimeout({
      command: { threadId: "t1", providerId: "acp" },
      options: {
        vkThreadStartRetries: retries,
        eventSink: { emit: (e) => emitted.push(e), flush: async () => {} },
        logger: { debug: () => {}, warn: (obj: unknown) => warnings.push(obj) },
      },
      start: () =>
        started.startThread({
          bridgeLaunch,
          environmentId: "env-1",
          projectId: "p1",
          providerId: "acp",
          threadId: "t1",
          options: {
            model: "test-model",
            serviceTier: "default",
            reasoningLevel: "medium",
            providerOptions: {},
            permissionMode: "full",
            permissionScope: "full",
            approvalReviewer: null,
            permissionEscalation: null,
          },
        }),
    });
    return { result, emitted, warnings };
  }

  it("opens the session on a fresh agent after the first one hangs", async () => {
    const { result, emitted, warnings } =
      await startWithAgentHungOnFirstSession(1);
    await expect(result).resolves.toMatchObject({
      providerThreadId: expect.any(String),
    });
    expect(runtime?.hasThread("t1")).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(emitted).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: "provider/warning" }),
      }),
    ]);
  }, 30_000);

  it("fails as before when retries are off", async () => {
    const { result } = await startWithAgentHungOnFirstSession(0);
    await expect(result).rejects.toThrow(/timed out: thread\/start/);
  }, 30_000);
});
