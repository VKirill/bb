import { describe, expect, it } from "vitest";
import {
  CALLER_LAUNCH_METADATA_PLUGIN_ID,
  callerLaunchRequestFieldsSchema,
  parsePersistedCallerLaunchIdentity,
  refineCallerLaunchRequest,
  serializeCallerLaunchBinding,
} from "../src/api/caller-launch.js";

describe("caller launch contract", () => {
  it("accepts a full identity and rejects a partial one", () => {
    expect(
      callerLaunchRequestFieldsSchema.parse({
        experimental_callerLaunchId: "11111111-1111-4111-8111-111111111111",
        experimental_callerAttemptId: "att_1",
        experimental_callerJobId: "job_1",
      }),
    ).toMatchObject({ experimental_callerAttemptId: "att_1" });
    const issues: string[] = [];
    refineCallerLaunchRequest({ experimental_callerJobId: "job_1" }, (message) => {
      issues.push(message);
    });
    expect(issues).toEqual([
      "experimental_callerLaunchId is required when any caller identity field is set",
      "experimental_callerAttemptId is required when any caller identity field is set",
    ]);
  });

  it("does not parse isolation metadata as a caller identity", () => {
    expect(
      parsePersistedCallerLaunchIdentity({
        isolatedSkillDelivery: true,
        skillIds: ["skill_ab"],
      }),
    ).toBeNull();
    expect(CALLER_LAUNCH_METADATA_PLUGIN_ID).toBe("bb-caller-launch");
  });

  it("serializes a binding with stable key order", () => {
    expect(
      serializeCallerLaunchBinding({
        skillIds: ["skill_b", "skill_a"],
        promptDigest: "a".repeat(64),
        isolatedSkillDelivery: false,
        environmentId: null,
        environment: { type: "host", hostId: "h1" },
        model: null,
        providerId: "codex",
        projectId: "proj",
        callerJobId: null,
        callerAttemptId: "att_1",
      }),
    ).toContain("\"callerAttemptId\":\"att_1\"");
  });
});
