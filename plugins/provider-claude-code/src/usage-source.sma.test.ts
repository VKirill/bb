import { expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { registerUsageSource } from "./usage-source.js";
import {
  usageFetchMethod,
  usageListMethod,
  usageMeasurementSchema,
  usageResourceListSchema,
} from "./usage-contract.js";

it("[sma:k_hsl_windows] the subscription windows are read per account from the provider, so the figures carry the account key and each window's percent and reset; a failed read says so without inventing a figure", async () => {
  const resetsAt = "2026-11-15T00:00:00.000Z";
  let fail = false;
  const usageLimits = vi.fn(async () => {
    if (fail) throw new Error("provider exploded");
    return {
      "claude-code": {
        status: "ok" as const,
        accountKey: "issuer:organization:sma",
        accountEmail: "person@example.com",
        planLabel: "max",
        plan: { id: "max", multiplier: 20 },
        windows: [
          {
            label: "5 hour window",
            kind: "five-hour",
            usedPercent: 37,
            resetsAt,
          },
          { label: "7 day window", kind: "weekly", usedPercent: 81, resetsAt },
        ],
      },
    };
  });
  const { bb, harness } = createFakePluginHost({
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host", status: "connected" }),
        ],
        get: async ({ hostId }) =>
          makeHostResponse({ id: hostId, status: "connected" }),
      },
      providers: {
        list: async () => [
          {
            id: "claude-code",
            displayName: "Claude Code",
            pluginId: "provider-claude-code",
          },
        ],
      },
      system: { usageLimits },
    },
  });
  try {
    registerUsageSource(bb);
    const read = async (refresh: boolean) =>
      usageMeasurementSchema.parse(
        await harness.behavior.callRpc(usageFetchMethod, {
          resourceId: JSON.stringify(["host", "claude-code"]),
          refresh,
        }),
      );

    const ok = await read(false);
    expect(usageLimits).toHaveBeenCalledWith({
      hostId: "host",
      providerId: "claude-code",
      refresh: false,
    });
    expect(ok.accountKey).toBe("issuer:organization:sma");
    expect(ok.usage.status).toBe("ok");
    if (ok.usage.status !== "ok") throw new Error("unreachable");
    expect(
      ok.usage.windows.map((window) => [
        window.id,
        window.kind,
        window.usedPercent,
        window.resetsAt,
      ]),
    ).toEqual([
      ["0:5 hour window", "five-hour", 37, resetsAt],
      ["1:7 day window", "weekly", 81, resetsAt],
    ]);
    const inventory = usageResourceListSchema.parse(
      await harness.behavior.callRpc(usageListMethod, {}),
    );
    expect(inventory.resources.map((resource) => resource.accountKey)).toEqual([
      "issuer:organization:sma",
    ]);

    fail = true;
    const failed = await read(true);
    expect(failed.usage).toMatchObject({
      status: "error",
      message: "Usage could not be collected from this machine.",
    });
    expect(failed.accountKey).toBe("issuer:organization:sma");
    expect(failed.observedAt).toBe(ok.observedAt);
  } finally {
    await harness.lifecycle.dispose();
  }
});
