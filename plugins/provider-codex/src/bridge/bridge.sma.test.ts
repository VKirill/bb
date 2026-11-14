import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_sma_codex_lane";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let requestLogPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-sma-ws-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }));
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  harness.sendRequest(991_002, "thread/stop", {
    threadId: THREAD_ID,
    providerThreadId: "sma-cleanup",
    intent: "release",
    activeTurnId: null,
  });
  await harness.waitForResponse(991_002).catch(() => undefined);
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function turnStartRequests() {
  const schema = z.object({
    method: z.string(),
    params: z.looseObject({}),
  });
  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)))
    .filter((request) => request.method === "turn/start")
    .map((request) => request.params);
}

it("[sma:m_ln_codex] every Codex turn carries its own sandbox and approval policy: a workspace-scoped turn is sandboxed to the workspace, a full-access turn after it is not", async () => {
  harness.sendRequest(1, "thread/start", {
    threadId: THREAD_ID,
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  const started = await harness.waitForResponse(1);
  const { providerThreadId } = z
    .object({ providerThreadId: z.string() })
    .parse(started.result);

  const sendTurn = async (
    id: number,
    options: Record<string, string | null>,
  ) => {
    harness.sendRequest(id, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: `creq_ssmmaacde${id}`,
      input: [{ type: "text", text: "say hello", mentions: [] }],
      options,
    });
    const response = await harness.waitForResponse(id);
    expect(response.error).toBeUndefined();
  };

  await sendTurn(2, FULL_ACCESS_SESSION_OPTIONS);
  await sendTurn(3, {
    permissionMode: "auto",
    permissionScope: "workspace",
    approvalReviewer: "automatic",
    permissionEscalation: "ask",
  });
  await sendTurn(4, FULL_ACCESS_SESSION_OPTIONS);

  const turns = turnStartRequests();
  expect(turns).toHaveLength(3);
  const sandboxTypes = turns.map(
    (params) =>
      (params["sandboxPolicy"] as { type?: string } | undefined)?.type,
  );
  expect(sandboxTypes[0]).toBe("dangerFullAccess");
  expect(sandboxTypes[1]).toBe("workspaceWrite");
  expect(sandboxTypes[2]).toBe("dangerFullAccess");
  expect(turns[0]?.["approvalPolicy"]).toBe("never");
  expect(turns[1]?.["approvalPolicy"]).not.toBe("never");
  expect(turns[2]?.["approvalPolicy"]).toBe("never");
}, 30_000);
