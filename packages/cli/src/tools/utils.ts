/**
 * Tool Utilities
 *
 * Common utilities used across all MCP tools.
 * Extracted from serve.ts formatting and helper functions.
 */

import type { McpResult } from "./types.js";

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Create a successful text result.
 */
export function formatToolResult(text: string, suggestion?: string): McpResult {
  const content = suggestion ? text + suggestion : text;
  return {
    content: [{ type: "text" as const, text: content }],
    toolResult: text,
  };
}

/**
 * Create an error result.
 */
export function formatError(message: string, details?: string): McpResult {
  const text = details ? `Error: ${message}\n${details}` : `Error: ${message}`;
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

/**
 * Create an image result.
 */
export function formatImageResult(data: string, mimeType: string): McpResult {
  return {
    content: [{ type: "image" as const, data, mimeType }],
  };
}

/**
 * Create a mixed result (text + image).
 */
export function formatMixedResult(
  text: string,
  images: Array<{ data: string; mimeType: string }>
): McpResult {
  return {
    content: [
      { type: "text" as const, text },
      ...images.map(img => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType
      })),
    ],
  };
}

// ============================================================================
// String Utilities
// ============================================================================

/**
 * Truncate a string to a maximum length.
 * Centers on a match position if provided.
 */
export function truncateString(
  str: string,
  maxLen: number,
  matchPos?: number
): string {
  if (str.length <= maxLen) return str;

  if (matchPos !== undefined && matchPos >= 0) {
    // Center around match
    const beforeLen = Math.floor(maxLen / 3);
    const afterLen = maxLen - beforeLen - 3; // 3 for "..."

    let start = Math.max(0, matchPos - beforeLen);
    let end = Math.min(str.length, matchPos + afterLen);

    // Adjust if at boundaries
    if (start === 0) {
      end = Math.min(str.length, maxLen - 3);
      return str.slice(0, end) + "...";
    }
    if (end === str.length) {
      start = Math.max(0, str.length - maxLen + 3);
      return "..." + str.slice(start);
    }

    return "..." + str.slice(start, end) + "...";
  }

  // Default: truncate from end
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Clean a line for display (remove excessive whitespace, truncate).
 */
export function cleanLine(line: string, maxLen: number = 100, pattern?: string): string {
  // Remove line number prefix if present
  let cleaned = line.replace(/^\d+:\s*/, "");

  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Find pattern position for centering
  let matchPos: number | undefined;
  if (pattern) {
    const idx = cleaned.toLowerCase().indexOf(pattern.toLowerCase());
    if (idx >= 0) matchPos = idx;
  }

  return truncateString(cleaned, maxLen, matchPos);
}

/**
 * Compact a file path for display.
 */
export function compactPath(filePath: string, maxLen: number = 50): string {
  if (filePath.length <= maxLen) return filePath;

  const parts = filePath.split(/[/\\]/);
  if (parts.length <= 2) {
    return truncateString(filePath, maxLen);
  }

  // Keep first and last parts, abbreviate middle
  const first = parts[0];
  const last = parts.slice(-2).join("/");
  const middle = "...";

  const result = `${first}/${middle}/${last}`;
  if (result.length <= maxLen) return result;

  // Still too long, just truncate
  return truncateString(filePath, maxLen);
}

// ============================================================================
// JSON Utilities
// ============================================================================

/**
 * Safely stringify JSON with circular reference handling.
 */
export function safeStringify(obj: unknown, indent?: number): string {
  const seen = new WeakSet();

  return JSON.stringify(obj, (key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    // Handle BigInt
    if (typeof value === "bigint") {
      return value.toString() + "n";
    }
    // Handle functions
    if (typeof value === "function") {
      return `[Function: ${value.name || "anonymous"}]`;
    }
    return value;
  }, indent);
}

/**
 * Pretty print JSON with size limit.
 */
export function prettyJson(obj: unknown, maxSize: number = 10000): string {
  const str = safeStringify(obj, 2);
  if (str.length <= maxSize) return str;

  // Truncate and add indicator
  return str.slice(0, maxSize) + "\n... [truncated]";
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Escape a string for FTS5 query.
 */
export function escapeFts5Query(query: string): string {
  // Remove FTS5 special characters
  return query
    .replace(/[":*^(){}[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate that required parameters are present.
 */
export function validateRequired(
  params: Record<string, unknown>,
  required: string[]
): string | null {
  for (const key of required) {
    if (params[key] === undefined || params[key] === null) {
      return `Missing required parameter: ${key}`;
    }
  }
  return null;
}

/**
 * Coerce a parameter to the expected type.
 */
export function coerceParam<T>(
  value: unknown,
  type: "string" | "number" | "boolean" | "array",
  defaultValue: T
): T {
  if (value === undefined || value === null) return defaultValue;

  switch (type) {
    case "string":
      return String(value) as T;
    case "number":
      const n = Number(value);
      return (isNaN(n) ? defaultValue : n) as T;
    case "boolean":
      return (value === true || value === "true" || value === 1) as T;
    case "array":
      return (Array.isArray(value) ? value : [value]) as T;
    default:
      return value as T;
  }
}

// ============================================================================
// Size Formatting
// ============================================================================

/**
 * Format bytes as human readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format milliseconds as human readable duration.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
