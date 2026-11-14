import { describe, expect, it } from "vitest";
import { buildSessionOptions } from "./session-options.js";
import { buildClaudeSessionParams } from "../session-params.js";

// VK EXPERIMENTAL: a plugin's launch tuning (`claude` half) narrows a Claude Code session at launch.

const base = {
  cwd: "/tmp/qa",
  instructionMode: "replace" as const,
  permissionMode: "acceptEdits" as const,
  permissionScope: "workspace" as const,
  workflowsEnabled: false,
  serviceTier: "default" as const,
  disable1MContext: false,
  sandboxEnabled: false,
  chromeEnabled: false,
  artifactsEnabled: false,
};

describe("claude launch tuning", () => {
  it("changes nothing without a tuning", () => {
    const options = buildSessionOptions(base, {});
    expect(options.vkDisallowedTools).toBeUndefined();
    expect(options.extraArgs).toBeUndefined();
  });

  it("changes nothing for a tuning that only sets ACP fields", () => {
    const options = buildSessionOptions(
      { ...base, vkLaunchTuning: { version: 1, acp: { mode: "ask" } } },
      {},
    );
    expect(options.vkDisallowedTools).toBeUndefined();
    expect(options.extraArgs).toBeUndefined();
  });

  it("adds the denied tools next to the denials a session policy already made", () => {
    const options = buildSessionOptions(
      {
        ...base,
        vkSessionPolicy: {
          version: 1,
          skills: { mode: "allow", names: [] },
        },
        vkLaunchTuning: {
          version: 1,
          claude: { disallowedTools: ["Edit", "Write", "Edit"] },
        },
      },
      {},
    );
    expect(options.vkDisallowedTools).toEqual(
      expect.arrayContaining(["Edit", "Write"]),
    );
    expect(options.vkDisallowedTools?.filter((tool) => tool === "Edit")).toHaveLength(1);
  });

  it("passes --disable-slash-commands and keeps the chrome flag", () => {
    const options = buildSessionOptions(
      {
        ...base,
        chromeEnabled: true,
        vkLaunchTuning: { version: 1, claude: { disableSlashCommands: true } },
      },
      {},
    );
    expect(options.extraArgs).toEqual({ chrome: null, "disable-slash-commands": null });
    expect(options.vkDisallowedTools).toBeUndefined();
  });

  it("does not pass --disable-slash-commands when the tuning says false", () => {
    const options = buildSessionOptions(
      { ...base, vkLaunchTuning: { version: 1, claude: { disableSlashCommands: false } } },
      {},
    );
    expect(options.extraArgs).toBeUndefined();
  });

  it("carries the tuning from provider options into the session params, and drops a bad one", () => {
    const tuning = { version: 1, claude: { disallowedTools: ["Write"] } };
    const params = (providerOptions: Record<string, unknown>) =>
      buildClaudeSessionParams({
        threadId: "thr_1",
        cwd: "/tmp/qa",
        instructionMode: "append",
        options: {
          permissionMode: "accept-edits",
          permissionScope: "workspace",
          approvalReviewer: "user",
          permissionEscalation: "ask",
          providerOptions,
        },
      });
    expect(params({ vkLaunchTuning: tuning }).vkLaunchTuning).toEqual(tuning);
    expect(params({ vkLaunchTuning: { version: 3 } })).not.toHaveProperty("vkLaunchTuning");
    expect(params({})).not.toHaveProperty("vkLaunchTuning");
  });
});
