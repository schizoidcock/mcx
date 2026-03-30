/**
 * Shared Zod utilities
 */
import { z } from "zod";

/**
 * Workaround for Claude Code bug that sends arrays as JSON strings.
 * Coerces string-encoded arrays back to arrays before validation.
 *
 * @example
 * const schema = coerceJsonArray(z.array(z.string()));
 * schema.parse('["a", "b"]') // => ["a", "b"]
 * schema.parse(["a", "b"])   // => ["a", "b"]
 */
export function coerceJsonArray<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* not JSON, return as-is */ }
    }
    return val;
  }, schema);
}
