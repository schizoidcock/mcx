/**
 * Result Truncation & Summarization
 *
 * Provides truncation with rawBytes tracking for token efficiency stats.
 * Handles circular references, depth limits, and character limits.
 */

import { FILE_HELPERS_LINE_COUNT } from "../context/create.js";
import {
  CHARACTER_LIMIT,
  GREP_MAX_LINE_WIDTH,
  GREP_MAX_PER_FILE,
  MAX_LINE_WIDTH,
  MAX_LOGS,
} from "../tools/constants.js";

// ============================================================================
// Constants (internal)
// ============================================================================

const MAX_SUMMARIZE_DEPTH = 10;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 5000;
const MAX_OBJECT_KEYS = 50;

// ============================================================================
// Stored Confirmation (ONE source of truth for tool outputs)
// ============================================================================

export interface StoredStats {
  lines?: number;
  bytes?: number;
  exitCode?: number;
}

/**
 * Format confirmation message for stored results.
 * Pure formatting - no side effects.
 */
export function formatStored(varName: string, stats: StoredStats): string {
  const name = varName.startsWith('$') ? varName : `$${varName}`;
  const info = stats.lines ? `${stats.lines} lines` : stats.bytes ? formatBytes(stats.bytes) : '';
  const status = stats.exitCode === 0 ? '✓' : stats.exitCode != null ? `✗ Exit ${stats.exitCode}` : '✓';
  return `${status} Stored ${name}${info ? ` (${info})` : ''}`;
}

// ============================================================================
// Types
// ============================================================================

export interface TruncateOptions {
  enabled?: boolean;
  maxItems?: number;
  maxStringLength?: number;
  maxDepth?: number;
}

export interface SummarizedResult {
  value: unknown;
  truncated: boolean;
  originalSize?: string;
  rawBytes: number;
}

// ============================================================================
// Helper
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

/** Truncate logs array with "... +N more" message */
export function truncateLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOGS) return logs;
  return [...logs.slice(0, MAX_LOGS), `... +${logs.length - MAX_LOGS} more`];
}

/** Filter out lint warnings from prepended FILE_HELPERS_CODE */
export function filterHelperLogs(logs: string[]): string[] {
  return logs.filter((_, i) => i >= FILE_HELPERS_LINE_COUNT);
}

// ============================================================================
// summarizeObject - Recursive truncation
// ============================================================================

function summarizeObject(
  obj: unknown,
  opts: TruncateOptions,
  depth: number,
  seen: WeakSet<object>
): unknown {
  const maxDepth = opts.maxDepth ?? MAX_SUMMARIZE_DEPTH;
  const maxItems = opts.maxItems ?? MAX_ARRAY_ITEMS;
  const maxStringLength = opts.maxStringLength ?? MAX_STRING_LENGTH;

  if (typeof obj === 'string') {
    return obj.length > maxStringLength ? obj.slice(0, maxStringLength) + `... [${obj.length - maxStringLength} more chars]` : obj;
  }

  if (depth >= maxDepth) return '[max depth]';

  if (obj === null || typeof obj !== 'object') return obj;

  if (seen.has(obj)) return '[circular]';
  seen.add(obj);

  if (Array.isArray(obj)) {
    const items = obj.slice(0, maxItems).map(item => summarizeObject(item, opts, depth + 1, seen));
    if (obj.length > maxItems) items.push(`... +${obj.length - maxItems} more items`);
    return items;
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(obj);
  let count = 0;
  for (const key of keys) {
    if (count >= MAX_OBJECT_KEYS) { result['...'] = `+${keys.length - count} more keys`; break; }
    result[key] = summarizeObject((obj as Record<string, unknown>)[key], opts, depth + 1, seen);
    count++;
  }
  return result;
}

// ============================================================================
// summarizeResult - Main export
// ============================================================================

export function summarizeResult(value: unknown, opts: TruncateOptions = {}): SummarizedResult {
  const rawBytes = JSON.stringify(value)?.length ?? 0;

  if (!opts.enabled) {
    return { value, truncated: false, rawBytes };
  }

  const summarized = summarizeObject(value, opts, 0, new WeakSet());
  const truncated = JSON.stringify(summarized) !== JSON.stringify(value);

  return {
    value: summarized,
    truncated,
    originalSize: truncated ? formatBytes(rawBytes) : undefined,
    rawBytes,
  };
}

// ============================================================================
// enforceCharacterLimit - Final safeguard with clean line breaks
// ============================================================================

/** Find last newline before target, within tolerance. Falls back to target. */
function findCleanCut(text: string, target: number, tolerance = 200): number {
  const idx = text.lastIndexOf('\n', target);
  return idx >= target - tolerance ? idx + 1 : target;
}

/** Find first newline after target, within tolerance. Falls back to target. */
function findCleanCutEnd(text: string, target: number, tolerance = 200): number {
  const idx = text.indexOf('\n', target);
  return idx > 0 && idx <= target + tolerance ? idx + 1 : target;
}

export function enforceCharacterLimit(text: string, limit: number = CHARACTER_LIMIT): string {
  const sanitized = sanitizeForJson(text);
  if (sanitized.length <= limit) return sanitized;

  const available = limit - 50;
  const targetStart = Math.floor(available * 0.6);
  const targetEnd = available - targetStart;

  // Cut at line boundaries for cleaner output
  const startCut = findCleanCut(sanitized, targetStart);
  const endCut = findCleanCutEnd(sanitized, sanitized.length - targetEnd);
  const omitted = endCut - startCut;

  return sanitized.slice(0, startCut) + `\n... [${omitted} chars truncated] ...\n` + sanitized.slice(endCut);
}

export function sanitizeForJson(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\uFFFD/g, '');
}

// ============================================================================
// formatFileResult - Format file operation results
// ============================================================================

export function formatFileResult(result: unknown, code?: string): string {
  if (result === undefined || result === null) return 'undefined';

  if (Array.isArray(result) && result.every(r => typeof r === 'string')) {
    const sliceMatch = code?.match(/\.slice\s*\(\s*(\d+)/);
    const offset = sliceMatch ? parseInt(sliceMatch[1], 10) : 0;
    return result.map((line, i) => {
      const numbered = `${offset + i + 1}: ${line}`;
      return numbered.length > MAX_LINE_WIDTH ? numbered.slice(0, MAX_LINE_WIDTH - 3) + '...' : numbered;
    }).join('\n');
  }

  if (typeof result === 'string') {
    return result.split('\n').map(line => line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH - 3) + '...' : line).join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ============================================================================
// String Truncation
// ============================================================================

export function truncateString(str: string, maxLen: number, matchPos?: number): string {
  if (str.length <= maxLen) return str;

  if (matchPos !== undefined && matchPos >= 0) {
    const beforeLen = Math.floor(maxLen / 3);
    const afterLen = maxLen - beforeLen - 3;
    const start = Math.max(0, matchPos - beforeLen);
    const end = Math.min(str.length, matchPos + afterLen);
    return (start > 0 ? "..." : "") + str.slice(start, end) + (end < str.length ? "..." : "");
  }

  // 60/40 split: start has more context than end
  const contentLen = maxLen - 6;
  const startLen = Math.floor(contentLen * 0.6);
  const endLen = contentLen - startLen;
  return str.slice(0, startLen) + "..." + str.slice(-endLen);
}

export function cleanLine(line: string, maxLen: number = 100, pattern?: string): string {
  let cleaned = line.replace(/^\d+:\s*/, "").replace(/\s+/g, " ").trim();
  let matchPos: number | undefined;
  if (pattern) {
    const idx = cleaned.toLowerCase().indexOf(pattern.toLowerCase());
    if (idx >= 0) matchPos = idx;
  }
  return truncateString(cleaned, maxLen, matchPos);
}

// ============================================================================
// UTF-8 Safe Truncation
// ============================================================================

/**
 * Truncate string at UTF-8 safe boundary using binary search.
 * Ensures multibyte chars (emojis) are not cut in half.
 */
export function truncateUtf8Safe(str: string, maxBytes: number, marker = '...'): string {
  if (Buffer.byteLength(str) <= maxBytes) return str;

  const budget = maxBytes - Buffer.byteLength(marker);
  let lo = 0, hi = str.length;

  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }

  return str.slice(0, lo) + marker;
}

/** Truncate JSON at UTF-8 safe boundary. */
export function truncateJsonUtf8Safe(value: unknown, maxBytes: number): string {
  return truncateUtf8Safe(JSON.stringify(value) ?? 'null', maxBytes, '... [truncated]');
}
