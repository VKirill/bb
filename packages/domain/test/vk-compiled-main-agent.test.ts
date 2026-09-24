import { describe, expect, it } from "vitest";
import {
  compiledMainAgentProviderAllowed,
  mutableMetadataTouchesCompiledAgent,
  parseVkCompiledMainAgent,
  readVkCompiledMainAgent,
  VK_COMPILED_MAIN_AGENT_METADATA_KEY,
  VK_COMPILED_MAIN_AGENT_PROVIDER_OPTION,
} from "../src/vk-compiled-main-agent.js";

const profile = {
  id: "dev-orchestrator",
  sourceVersion: "lp-owned-1",
  sourceHash: "c".repeat(64),
  description: "Lane Pilot development orchestrator",
  prompt: "You are the Lane Pilot development orchestrator.",
};

describe("vk compiled main agent", () => {
  it("reads a typed snapshot from provider options and refuses an incomplete required payload", () => {
    expect(
      readVkCompiledMainAgent({
        [VK_COMPILED_MAIN_AGENT_PROVIDER_OPTION]: profile,
      }),
    ).toEqual(profile);
    expect(readVkCompiledMainAgent({})).toBeNull();
    expect(() => parseVkCompiledMainAgent({ ...profile, id: "" })).toThrow(
      /vk_compiled_main_agent_incomplete/,
    );
    expect(compiledMainAgentProviderAllowed("claude-code")).toBe(true);
    expect(compiledMainAgentProviderAllowed("codex")).toBe(false);
    expect(
      mutableMetadataTouchesCompiledAgent({
        [VK_COMPILED_MAIN_AGENT_METADATA_KEY]: profile,
      }),
    ).toBe(true);
    expect(mutableMetadataTouchesCompiledAgent({ role: "pm" })).toBe(false);
  });
});
