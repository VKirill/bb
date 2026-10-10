import { describe, expect, it } from "vitest";
import {
  REQUIRED_THREAD_SPAWN_CREATE_KEYS,
  buildExperimentalThreadSpawnContract,
  experimentalThreadSpawnContractSchema,
} from "../src/api/thread-spawn-contract.js";

describe("experimental thread spawn contract", () => {
  it("emits loaded create/list/response keys and persist unique, not caller flags", () => {
    const contract = buildExperimentalThreadSpawnContract("0.43.1");
    expect(experimentalThreadSpawnContractSchema.parse(contract)).toEqual(contract);
    expect(contract.protocol).toBe("bb-experimental-thread-spawn-contract-v1");
    expect(contract.appVersion).toBe("0.43.1");
    expect(contract.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    for (const key of REQUIRED_THREAD_SPAWN_CREATE_KEYS) {
      expect(contract.createThreadRequestKeys).toContain(key);
    }
    expect(contract.threadListQueryKeys).toContain("experimental_callerLaunchId");
    expect(contract.threadListQueryKeys).toContain("originPluginId");
    expect(contract.threadResponseKeys).toContain("experimental_callerLaunchId");
    expect(contract.threadResponseKeys).toContain("experimental_callerAttemptId");
    expect(contract.threadResponseKeys).toContain("experimental_callerJobId");
    expect(contract.persist).toEqual({
      table: "thread_caller_launches",
      unique: ["origin_plugin_id", "caller_launch_id"],
    });
    expect(contract.policies.forkDoesNotInheritCallerIdentity).toBe(true);
    expect(contract.policies.hiddenVisibilitySupported).toBe(true);
    expect(Object.hasOwn(contract, "capabilities")).toBe(false);
  });
});
