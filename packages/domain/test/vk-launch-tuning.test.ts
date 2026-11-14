import { describe, expect, it } from "vitest";
import {
  VK_LAUNCH_TUNING_PROVIDER_OPTION,
  parseVkLaunchTuning,
  readVkLaunchTuning,
  sanitizeVkAcpLaunch,
} from "../src/vk-launch-tuning.js";

describe("VK launch tuning", () => {
  it("reads nothing from options that carry no tuning", () => {
    expect(readVkLaunchTuning(undefined)).toBeNull();
    expect(readVkLaunchTuning({})).toBeNull();
    expect(readVkLaunchTuning([])).toBeNull();
    expect(
      readVkLaunchTuning({ [VK_LAUNCH_TUNING_PROVIDER_OPTION]: "ask" }),
    ).toBeNull();
  });

  it("rejects a wrong version, an unknown key and an oversized list instead of half applying it", () => {
    expect(parseVkLaunchTuning({ version: 2, acp: { mode: "ask" } })).toBeNull();
    expect(parseVkLaunchTuning({ version: 1, acp: { mode: "ask", yolo: true } })).toBeNull();
    expect(parseVkLaunchTuning({ version: 1, other: {} })).toBeNull();
    expect(
      parseVkLaunchTuning({ version: 1, claude: { disallowedTools: Array(65).fill("Edit") } }),
    ).toBeNull();
  });

  it("round-trips a valid tuning", () => {
    const tuning = {
      version: 1,
      acp: { mode: "ask", args: ["--sandbox"] },
      claude: { disallowedTools: ["Edit", "Write"], disableSlashCommands: true },
    };
    expect(readVkLaunchTuning({ [VK_LAUNCH_TUNING_PROVIDER_OPTION]: tuning })).toEqual(tuning);
  });

  it("sanitizes an absent ACP tuning to a no-op", () => {
    expect(sanitizeVkAcpLaunch(undefined)).toEqual({ args: [], dropped: [] });
    expect(sanitizeVkAcpLaunch({})).toEqual({ args: [], dropped: [] });
  });

  it("lets through the narrowing modes and args", () => {
    expect(
      sanitizeVkAcpLaunch({
        mode: "plan",
        args: ["--sandbox", "--agent-type", "review"],
      }),
    ).toEqual({
      mode: "plan",
      args: ["--sandbox", "--agent-type", "review"],
      dropped: [],
    });
  });

  it("drops modes and flags that would widen or change the agent", () => {
    const launch = sanitizeVkAcpLaunch({
      mode: "bypass",
      args: ["--dangerously-skip-permissions", "--agent-type", "summarizer", "--sandbox"],
    });
    expect(launch.mode).toBeUndefined();
    expect(launch.args).toEqual(["--sandbox"]);
    expect(launch.dropped).toEqual([
      "mode bypass",
      "arg --dangerously-skip-permissions",
      "arg --agent-type",
      "arg summarizer",
    ]);
  });

  it("does not repeat a flag the plugin listed twice", () => {
    expect(sanitizeVkAcpLaunch({ args: ["--sandbox", "--sandbox"] }).args).toEqual(["--sandbox"]);
  });
});
