import { describe, expect, it } from "vitest";
import {
  experimentalThreadSpawnContractSchema,
  type ExperimentalThreadSpawnContract,
} from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("GET /api/v1/system/experimental_thread-spawn-contract", () => {
  it("returns the loaded-core contract fingerprint, not env capability flags", async () => {
    await withTestHarness({ appVersion: "0.43.1" }, async (harness) => {
      const response = await harness.app.request(
        "/api/v1/system/experimental_thread-spawn-contract",
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as ExperimentalThreadSpawnContract;
      expect(experimentalThreadSpawnContractSchema.parse(body)).toEqual(body);
      expect(body.appVersion).toBe("0.43.1");
      expect(body.createThreadRequestKeys).toContain("experimental_callerLaunchId");
      expect(body.createThreadRequestKeys).toContain("isolatedSkillDelivery");
      expect(Object.hasOwn(body, "capabilities")).toBe(false);
    });
  });
});
