import { describe, expect, it } from "vitest";
import { listQueuedThreadMessages } from "@bb/db";
import type { PromptInput } from "@bb/domain";
import { deriveTitleFallback } from "../../src/services/threads/title-generation.js";
import {
  registerHostRpcResponder,
  type HostRpcHandlerResult,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
} from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("a message to an idle thread starts the provider turn itself (core: sendThreadMessage)", () => {
  it("[sma:m_cf_spawn] the owner's message to an idle thread is submitted to the host in the same call: one turn.submit with the text, no queued row, no waiting for a later pass", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        providerId: "pi",
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-thread-direct",
        threadId: thread.id,
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

      const response = await harness.app.request(`/api/v1/threads/${thread.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "start",
          input: [{ type: "text", text: "run the checks now" }],
        }),
      });
      expect(response.status).toBe(200);
      const submits = responder.requests.filter(({ command }) => command.type === "turn.submit");
      expect(submits).toHaveLength(1);
      expect(submits[0]?.command).toMatchObject({
        type: "turn.submit",
        threadId: thread.id,
        resumeContext: { providerId: "pi", providerThreadId: "provider-thread-direct" },
      });
      expect(JSON.stringify(submits[0]?.command)).toContain("run the checks now");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });
});

describe("a thread without a name gets a readable one at once (core: deriveTitleFallback)", () => {
  const text = (value: string): PromptInput => ({ type: "text", text: value }) as PromptInput;

  it("[sma:k_hss_register] the first prompt becomes the name: one line, trimmed, at most eighty columns with an ellipsis; nothing to read gives no name", () => {
    expect(deriveTitleFallback([text("  fix the\n   login   page \t bug ")])).toBe("fix the login page bug");
    expect(deriveTitleFallback([text("first part"), text("second part")])).toBe("first part second part");
    const long = deriveTitleFallback([text("word ".repeat(40))]);
    expect(long).not.toBeNull();
    expect(long?.length).toBe(80);
    expect(long?.endsWith("...")).toBe(true);
    expect(long?.startsWith("word word word")).toBe(true);
    const exact = "x".repeat(80);
    expect(deriveTitleFallback([text(exact)])).toBe(exact);
    expect(deriveTitleFallback([text("y".repeat(81))])).toBe(`${"y".repeat(77)}...`);
    expect(deriveTitleFallback([text("   \n ")])).toBeNull();
    expect(deriveTitleFallback([])).toBeNull();
  });
});
