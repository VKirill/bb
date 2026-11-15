import { describe, expect, it } from "vitest";
import type { RuntimePermissionPolicy } from "@get-bb/plugin-sdk/provider-bridge";
import { toCodexThreadPermissionSettings } from "./session-params.js";

// SMA map, region 7, n660 (m_ss_codex_args): «A sandbox instead of a tool list, approval policy «never».»
// A Codex session gets its rights as a sandbox and an approval policy, never as a list of allowed tools: the workspace
// scope is the workspace-write sandbox (no approval prompt when escalation is denied), the full scope is full access
// with no prompts at all.

const options = (
  permissionScope: "workspace" | "full",
  permissionEscalation: "ask" | "deny",
): RuntimePermissionPolicy =>
  ({
    permissionMode: "accept-edits",
    permissionScope,
    approvalReviewer: "user",
    permissionEscalation,
  }) satisfies RuntimePermissionPolicy;

describe("the Codex session's rights (core: provider-codex toCodexThreadPermissionSettings)", () => {
  it("[sma:m_ss_codex_args] each scope is a sandbox with an approval policy and no tool list: workspace-write without prompts when escalation is denied, full access never prompts", () => {
    expect(toCodexThreadPermissionSettings(options("workspace", "deny"))).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    expect(toCodexThreadPermissionSettings(options("full", "ask"))).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(toCodexThreadPermissionSettings(options("full", "deny"))).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    // Only an allowed escalation inside the workspace asks the person.
    expect(toCodexThreadPermissionSettings(options("workspace", "ask"))).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
  });
});
