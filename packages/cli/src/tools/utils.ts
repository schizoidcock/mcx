/**
 * Tool Utilities
 *
 * Common utilities used across all MCP tools.
 * Extracted from serve.ts formatting and helper functions.
 */

import type { McpResult } from "./types.js";
import { enforceCharacterLimit, sanitizeForJson } from "../utils/truncate.js";

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Create a successful text result.
 */
export function formatToolResult(text: string, suggestion?: string): McpResult {
  const sanitized = sanitizeForJson(text);
  const limited = enforceCharacterLimit(sanitized);
  const content = suggestion ? limited + suggestion : limited;
  return {
    content: [{ type: "text" as const, text: content }],
    toolResult: limited,
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
 * Create a mixed text+image result.
 */
export function formatMixedResult(
  text: string,
  images: Array<{ data: string; mimeType: string }>
): McpResult {
  return {
    content: [
      { type: "text" as const, text },
      ...images.map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      })),
    ],
  };
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
    return value;
  }, indent);
}

/**
 * Pretty-print JSON with size limit.
 */
export function prettyJson(obj: unknown, maxSize: number = 10000): string {
  const json = safeStringify(obj, 2);
  if (json.length <= maxSize) return json;
  return json.slice(0, maxSize) + "\n... [truncated]";
}

// ============================================================================
// FTS5 Query Utilities
// ============================================================================

/**
 * Escape a query string for FTS5.
 */
export function escapeFts5Query(query: string): string {
  // Escape special FTS5 characters
  return query
    .replace(/"/g, '""')
    .replace(/\*/g, "")
    .replace(/\(/g, "")
    .replace(/\)/g, "");
}

// ============================================================================
// Parameter Validation
// ============================================================================

/**
 * Validate required parameters exist.
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
 * Coerce a parameter to a specific type with default.
 */
export function coerceParam<T>(
  value: unknown,
  defaultValue: T,
  coerce: (v: unknown) => T
): T {
  if (value === undefined || value === null) return defaultValue;
  try {
    return coerce(value);
  } catch {
    return defaultValue;
  }
}

// ============================================================================
// Display Utilities
// ============================================================================

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format duration as human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
