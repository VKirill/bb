import { describe, expect, it } from "vitest";
import {
  THREAD_LIST_MAX_IDS,
  sendMessageRequestSchema,
  threadListQuerySchema,
  updateThreadRequestSchema,
} from "../src/api/threads.js";

describe("thread request schemas (SMA proofs)", () => {
  it("[sma:m_cb_list] the conversation list of one project takes the project and the archived flag, and refuses a list of more ids than the cap", () => {
    expect(
      threadListQuerySchema.parse({ projectId: "prj_one", archived: "false" }),
    ).toEqual({ projectId: "prj_one", archived: "false" });
    expect(threadListQuerySchema.safeParse({ archived: "maybe" }).success).toBe(
      false,
    );
    const atCap = Array.from(
      { length: THREAD_LIST_MAX_IDS },
      (_, i) => `thr_${i}`,
    ).join(",");
    const overCap = `${atCap},thr_extra`;
    expect(threadListQuerySchema.safeParse({ threadIds: atCap }).success).toBe(
      true,
    );
    expect(
      threadListQuerySchema.safeParse({ threadIds: overCap }).success,
    ).toBe(false);
    expect(threadListQuerySchema.safeParse({ limit: "-1" }).success).toBe(
      false,
    );
  });

  it("[sma:m_cb_rename] a rename carries only the new title, an empty title and an empty body are refused", () => {
    expect(updateThreadRequestSchema.parse({ title: "New name" })).toEqual({
      title: "New name",
    });
    expect(updateThreadRequestSchema.parse({ title: null })).toEqual({
      title: null,
    });
    expect(updateThreadRequestSchema.safeParse({ title: "" }).success).toBe(
      false,
    );
    expect(updateThreadRequestSchema.safeParse({}).success).toBe(false);
  });

  it("[sma:m_cd_door] the send door keeps only the listed fields, needs a non-empty input and a mode", () => {
    const parsed = sendMessageRequestSchema.parse({
      input: [{ type: "text", text: "hello" }],
      mode: "queue-if-active",
      smuggled: "x",
      cwd: "/etc",
    });
    expect(Object.keys(parsed).sort()).toEqual(["input", "mode"]);
    expect(
      sendMessageRequestSchema.safeParse({ input: [], mode: "queue-if-active" })
        .success,
    ).toBe(false);
    expect(
      sendMessageRequestSchema.safeParse({
        input: [{ type: "text", text: "hello" }],
      }).success,
    ).toBe(false);
  });
});
