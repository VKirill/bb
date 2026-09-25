import type { PluginDispatchEnvironmentIntent } from "@get-bb/plugin-sdk";

export function vkIntentPath(
  intent: PluginDispatchEnvironmentIntent | null,
): string | null {
  const inputs = intent?.kind === "provider" ? intent.inputs : null;
  if (inputs !== null && typeof inputs === "object" && !Array.isArray(inputs)) {
    const path = (inputs as Record<string, unknown>).path;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return null;
}
