/**
 * Tool Utilities
 *
 * Common utilities used across all MCP tools.
 * Extracted from serve.ts formatting and helper functions.
 */

import type { McpResult } from "./types.js";
import type { SearchResult } from "../search/types.js";
import { getContentStore } from "../context/store.js";
import { enforceCharacterLimit, sanitizeForJson } from "../utils/truncate.js";
import { FORMAT_INDEX_THRESHOLD } from "./constants.js";

// ============================================================================
// Result Formatting
// ============================================================================

// Index large output and return preview (avoids truncation)
function indexLargeOutput(text: string, label: string): string {
  const store = getContentStore();
  store.index(text, label, { contentType: "plaintext" });
  const lines = text.split('\n').length;
  return `Indexed ${lines} lines as "${label}"\n-> mcx_search({ queries: [...], source: "${label}" })`;
}

/**
 * Create a successful text result.
 * Large outputs are indexed instead of truncated.
 */
export function formatToolResult(text: string, suggestion?: string, label?: string): McpResult {
  const sanitized = sanitizeForJson(text);
  
  const output = sanitized.length > FORMAT_INDEX_THRESHOLD
    ? indexLargeOutput(sanitized, label || `output:${Date.now()}`)
    : enforceCharacterLimit(sanitized);
  
  const content = suggestion ? output + suggestion : output;
  return { content: [{ type: "text" as const, text: content }], toolResult: output };
}

/**
 * Create an error result.
 */
export function formatError(message: string, details?: string): McpResult {
  const prefix = /^(Error|Warning|\w+Error):/i.test(message) ? '' : 'Error: ';
  const text = details ? `${prefix}${message}\n${details}` : `${prefix}${message}`;
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

// ============================================================================
// Display Utilities
// ============================================================================

/**
 * Format bytes as human-readable string.
 */
// ============================================================================
// Diff Summary (Linus-style: small focused helpers)
// ============================================================================

/** Group contiguous numbers into ranges: [1,2,3,7,8] -> "1-3, 7-8" */
function groupRanges(nums: number[]): string {
  if (nums.length === 0) return '';
  const ranges: string[] = [];
  let start = nums[0], end = nums[0];
  
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== end + 1) {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = nums[i];
    }
    end = nums[i];
  }
  
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.slice(0, 3).join(', ') + (ranges.length > 3 ? '...' : '');
}

/** Find first diff position and all modified line numbers */
function findModifiedLines(oldLines: string[], newLines: string[]): { firstDiff: number; modified: number[] } {
  let firstDiff = -1;
  const modified: number[] = [];
  const minLen = Math.min(oldLines.length, newLines.length);
  
  for (let i = 0; i < minLen; i++) {
    if (oldLines[i] === newLines[i]) continue;
    if (firstDiff === -1) firstDiff = i + 1;
    modified.push(i + 1);
  }
  
  return { firstDiff, modified };
}

/** Build delta indicator: [+N], [-N], or null */
function buildDeltaPart(delta: number, firstDiff: number, oldCount: number, newCount: number): string | null {
  if (delta > 0) {
    const start = firstDiff > 0 ? firstDiff : oldCount + 1;
    return `[+${delta}] at ${start}-${start + delta - 1}`;
  }
  if (delta < 0) {
    const start = firstDiff > 0 ? firstDiff : newCount + 1;
    return `[-${Math.abs(delta)}] at ${start}`;
  }
  return null;
}

/** Generate compact diff summary. Format: "10->15 lines ([+5] at 6-10, modified 6-10)" */
/** Format modified lines description */
const formatModified = (modified: number[]): string | null => {
  if (modified.length === 0) return null;
  if (modified.length <= 20) return `modified ${groupRanges(modified)}`;
  return `modified ${modified.length} lines`;
};

export function diffSummary(oldContent: string, newContent: string): string {
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent ? newContent.split('\n') : [];
  const { firstDiff, modified } = findModifiedLines(oldLines, newLines);
  
  const delta = buildDeltaPart(newLines.length - oldLines.length, firstDiff, oldLines.length, newLines.length);
  const mod = formatModified(modified);
  const parts = [delta || (modified.length > 0 ? '[~]' : null), mod].filter(Boolean);
  
  const changes = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${oldLines.length}->${newLines.length} lines${changes}`;
}

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

// ============================================================================
// Index & Search Workflow
// ============================================================================

export interface IndexSearchResult {
  sourceId: number;
  results: SearchResult[];
  terms: string[];
}

/**
 * Index content and search with intent.
 * Returns results or distinctive terms if no matches.
 */
export function indexAndSearch(
  content: string,
  label: string,
  intent: string,
  contentType: "plaintext" | "code"
): IndexSearchResult {
  const store = getContentStore();
  const sourceId = store.index(content, label, { contentType });
  const results = store.search(intent, { limit: 5, sourceId });
  const terms = results.length === 0 ? store.getDistinctiveTerms(sourceId, 8) : [];
  return { sourceId, results, terms };
}