import { describe, expect, it } from "vitest";
import { systemMessageSubjectSchema } from "@bb/domain";

// VK EXPERIMENTAL (delivered-label): a tool-call subject may carry the plugin's completed label; one without it reads as before.
describe("delivered-label", () => {
  it("keeps the label on a tool-call subject and accepts one without it", () => {
    expect(systemMessageSubjectSchema.parse({ kind: "tool-call", toolName: "lane_pilot_ask_owner", suppress: false, label: "Владелец ответил" }))
      .toEqual({ kind: "tool-call", toolName: "lane_pilot_ask_owner", suppress: false, label: "Владелец ответил" });
    expect(systemMessageSubjectSchema.parse({ kind: "tool-call", toolName: "grill_round", suppress: false }))
      .toEqual({ kind: "tool-call", toolName: "grill_round", suppress: false });
  });
});
