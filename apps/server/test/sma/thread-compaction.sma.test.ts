import { describe, expect, it } from "vitest";
import { createStandaloneBuiltinCompactCommandInput } from "@bb/domain";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("conversation context in budget (core: compactThreadContext)", () => {
  it("[sma:m_cf_context] an idle thread's past turns are folded by one provider /compact turn; a busy thread and a provider without compaction are refused and send nothing", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const idle = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "pi",
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-budget",
        threadId: idle.id,
      });
      const busy = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "codex",
        status: "active",
      });
      const unsupported = seedThread(harness.deps, {
        projectId: project.id,
        providerId: "acp-cursor",
        status: "idle",
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }): HostRpcHandlerResult => {
          if (command.type === "host.read_workspace_agent_context") {
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          }
          if (command.type === "turn.submit") {
            return { ok: true, result: { trace: { spans: [] } } };
          }
          return { ok: true, result: {} };
        },
      });
      const submits = () =>
        responder.requests.filter(({ command }) => command.type === "turn.submit");

      const refusedBusy = await harness.app.request(`/api/v1/threads/${busy.id}/compact`, {
        method: "POST",
      });
      expect(refusedBusy.status).toBe(409);
      expect(await readJson(refusedBusy)).toMatchObject({
        message: "Context can only be compacted while the thread is idle or errored",
      });
      const refusedProvider = await harness.app.request(
        `/api/v1/threads/${unsupported.id}/compact`,
        { method: "POST" },
      );
      expect(refusedProvider.status).toBe(409);
      expect(await readJson(refusedProvider)).toMatchObject({
        message: 'Provider "acp-cursor" does not support manual context compaction',
      });
      expect(submits()).toHaveLength(0);

      const response = await harness.app.request(`/api/v1/threads/${idle.id}/compact`, {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(submits()).toHaveLength(1);
      expect(submits()[0]?.command).toMatchObject({
        type: "turn.submit",
        threadId: idle.id,
        input: createStandaloneBuiltinCompactCommandInput(),
        resumeContext: { providerId: "pi", providerThreadId: "provider-thread-budget" },
      });
    });
  });
});
