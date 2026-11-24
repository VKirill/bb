// VK EXPERIMENTAL — absent from upstream bb.
// A plugin tool that starts long work answers the model at once and lets bb deliver its eventual result as a
// `tool-result-delivered` system message: the path `bb.ui.requestInput` already takes, without showing a form.
import { vkDetachActivePluginToolCall } from "./plugin-tool-calls.js";

export const VK_DETACHED_TOOL_CALL_DEFAULT_TEXT =
  "The work has started. Its result will arrive separately as this tool's delivered result. Do not call the tool again or poll for it; continue independent work, or briefly say what you are waiting for and end your turn.";

const VK_DETACHED_TOOL_CALL_TEXT_MAX = 2000;

/** Detaches the tool call running in this async context. False outside a tool's `execute` or after its call was aborted. */
export function vkDetachToolCall(text?: string): boolean {
  const notice = typeof text === "string" && text.trim() ? text.trim().slice(0, VK_DETACHED_TOOL_CALL_TEXT_MAX) : VK_DETACHED_TOOL_CALL_DEFAULT_TEXT;
  return vkDetachActivePluginToolCall(notice);
}
