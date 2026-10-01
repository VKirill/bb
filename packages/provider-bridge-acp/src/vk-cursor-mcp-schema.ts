/**
 * VK EXPERIMENTAL — not part of upstream bb.
 *
 * Cursor's MCP client rejects tools/list unless every inputSchema has
 * type: "object". Plugin tools that use JSON Schema oneOf (no type) cause
 * Cursor to drop the whole bb-bridge server, so GetDynamicTools never
 * sees image_studio_generate.
 */

export function vkCursorSafeMcpInputSchema(
  schema: unknown,
): Record<string, unknown> {
  const obj =
    schema !== null && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : {};
  if (obj.type === "object") {
    return obj;
  }
  return { ...obj, type: "object" };
}
