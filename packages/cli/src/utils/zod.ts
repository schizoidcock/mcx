

/**
 * Coerce JSON string arrays in params object.
 * Claude Code sends arrays as JSON strings - this fixes them.
 * 
 * ONE source of truth for array coercion.
 */
export function coerceArrayParams(
  params: Record<string, unknown>,
  schema: { properties?: Record<string, { type?: string }> }
): void {
  const props = schema.properties || {};
  for (const [key, def] of Object.entries(props)) {
    if (def.type !== "array" || typeof params[key] !== "string") continue;
    try { params[key] = JSON.parse(params[key] as string); } catch { /* keep as-is */ }
  }
}
