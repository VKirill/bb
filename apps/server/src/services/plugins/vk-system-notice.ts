// VK EXPERIMENTAL — absent from upstream bb.
// A plugin's notice to a thread as bb's own system message (`initiator: "system"`, a titled `tool-result-delivered`
// row) instead of `threads.send` text, which bb records as `initiator: "user"`: the owner and the model read such a
// send as the owner's own words. Same queue and delivery as a detached tool result (`queueParentSystemMessage`).
import { getThread } from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { queueParentSystemMessage } from "../threads/parent-system-messages.js";

export interface VkSystemNoticeArgs {
  threadId: string;
  /** What the agent reads; up to 100 000 characters. */
  text: string;
  /** Row title in the timeline (80 characters at most); defaults to the plugin id. */
  label?: string;
  /** "queue" (default) waits for the thread's running turn to end; "steer" joins it, as bb's own child notices do. */
  mode?: "queue" | "steer";
}

const TEXT_MAX = 100_000;
const LABEL_MAX = 80;

type Sink = (pluginId: string, args: VkSystemNoticeArgs) => Promise<boolean>;
let sink: Sink | null = null;

/** Server boot binds the queue once its dependencies exist (`registerInternalToolCallRoutes`). */
export function vkInstallSystemNoticeSink(deps: LoggedPendingInteractionWorkSessionDeps): void {
  sink = async (pluginId, args) => {
    const thread = getThread(deps.db, args.threadId);
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) return false;
    const label = args.label?.trim().slice(0, LABEL_MAX);
    return queueParentSystemMessage(deps, {
      input: [{ type: "text", text: args.text.slice(0, TEXT_MAX), mentions: [] }],
      parentThreadId: thread.id,
      deliveryMode: args.mode === "steer" ? "steer" : "queue",
      systemMessageKind: "tool-result-delivered",
      systemMessageSubject: { kind: "tool-call", toolName: pluginId, suppress: false, label: label || pluginId },
    });
  };
}

export function createVkSystemNoticeMethods(args: { pluginId: string; assertLive: () => void }) {
  return {
    async experimental_vkSystemNotice(notice: VkSystemNoticeArgs): Promise<boolean> {
      args.assertLive();
      if (!notice || typeof notice.threadId !== "string" || !notice.threadId) throw new Error("experimental_vkSystemNotice needs a threadId");
      if (typeof notice.text !== "string" || !notice.text.trim()) throw new Error("experimental_vkSystemNotice needs a non-empty text");
      if (notice.label !== undefined && typeof notice.label !== "string") throw new Error("experimental_vkSystemNotice label must be a string");
      if (notice.mode !== undefined && notice.mode !== "queue" && notice.mode !== "steer") throw new Error('experimental_vkSystemNotice mode must be "queue" or "steer"');
      if (!sink) throw new Error("experimental_vkSystemNotice is unavailable in this host");
      return sink(args.pluginId, notice);
    },
  };
}
