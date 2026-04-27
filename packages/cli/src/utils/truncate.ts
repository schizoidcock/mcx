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
import { createDebugger } from "../utils/debug.js";

const debug = createDebugger("truncate");

const MAX_SUMMARIZE_DEPTH = 10;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 5000;
const MAX_OBJECT_KEYS = 50;

export interface StoredStats {
  lines?: number;
  bytes?: number;
  exitCode?: number;
}

export function formatStored(varName: string, stats: StoredStats): string {
  const name = varName.startsWith('$') ? varName : `$${varName}`;
  const info = stats.lines ? `${stats.lines} lines` : stats.bytes ? formatBytes(stats.bytes) : '';
  const status = stats.exitCode === 0 ? '✓' : stats.exitCode != null ? `✗ Exit ${stats.exitCode}` : '✓';
  return `${status} Stored ${name}${info ? ` (${info})` : ''}`;
}

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
  truncatedBytes?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

export function truncateLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOGS) return logs;
  return [...logs.slice(0, MAX_LOGS), `... +${logs.length - MAX_LOGS} more`];
}

export function filterHelperLogs(logs: string[]): string[] {
  return logs.filter(log => {
    const lineMatch = log.match(/(?:line |:)(\d+)/i);
    if (!lineMatch) return true;
    const lineNum = parseInt(lineMatch[1], 10);
    return lineNum > FILE_HELPERS_LINE_COUNT;
  });
}

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

  const result = {};
  const keys = Object.keys(obj);
  let count = 0;
  for (const key of keys) {
    if (count >= MAX_OBJECT_KEYS) { result['...'] = `+${keys.length - count} more keys`; break; }
    result[key] = summarizeObject((obj as Record<string, unknown>)[key], opts, depth + 1, seen);
    count++;
  }
  return result;
}

const TREE_SKIP_KEYS = new Set(['id', 'name', 'date', 'status', 'state', 'total', 'amount', 'created_at', 'number', 'title']);
const TREE_ID_KEYS = ['id', 'name', 'number', 'title'];
const TREE_STATUS_KEYS = ['status', 'state'];
const TREE_AMOUNT_KEYS = ['total', 'amount'];
const TREE_DATE_KEYS = ['date', 'created_at'];
const TREE_MAX_ITEMS = 10;

function escapeField(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return '[' + val.map(v => escapeField(v)).join(',') + ']';
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>).map(([k, v]) => k + ':' + escapeField(v));
    return '{' + entries.join(',') + '}';
  }
  const s = String(val);
  const PIPE = String.fromCharCode(124);
  const NL = String.fromCharCode(10);
  if (!s.includes(PIPE) && !s.includes(NL)) return s;
  return '"' + s.replace(/"/g, '""').replace(/\n/g, '\\n') + '"';
}

function isUniformArray(arr: unknown[]): arr is Record<string, unknown>[] {
  if (arr.length === 0) return false;
  return arr.every(item => typeof item === 'object' && item !== null && !Array.isArray(item));
}

export function toTOON(items: Record<string, unknown>[], name = 'data'): string {
  if (!items.length) return name + '[0]{}';
  const allKeys = new Set();
  for (const item of items) Object.keys(item).forEach(k => allKeys.add(k));
  const keys = Array.from(allKeys);
  const header = name + '[' + items.length + ']{' + keys.join(',') + '}:';
  const rows = items.map(item => '  ' + keys.map(k => escapeField(item[k])).join('|'));
  return [header, ...rows].join('\n');
}

function getDepth(obj: unknown, current = 0): number {
  if (current > 5) return current;
  if (obj === null || typeof obj !== 'object') return current;
  if (Array.isArray(obj)) {
    return obj.length ? Math.max(...obj.map(v => getDepth(v, current + 1))) : current + 1;
  }
  const vals = Object.values(obj);
  return vals.length ? Math.max(...vals.map(v => getDepth(v, current + 1))) : current + 1;
}

function countFields(obj: unknown): number {
  if (obj === null || typeof obj !== 'object') return 0;
  if (Array.isArray(obj)) return obj.reduce((n, v) => n + countFields(v), 0);
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.length + entries.reduce((n, [, v]) => n + countFields(v), 0);
}

function formatTreeSummary(item: Record<string, unknown>, idKey: string | undefined, index: number): string {
  const id = idKey ? item[idKey] : index;
  const status = TREE_STATUS_KEYS.map(k => item[k]).find(Boolean) || '';
  const total = TREE_AMOUNT_KEYS.map(k => item[k]).find(Boolean) || '';
  const date = TREE_DATE_KEYS.map(k => item[k]).find(Boolean) || '';

  let sum = '#' + id;
  if (date) sum += ' (' + String(date).slice(0, 10) + ')';
  if (status) sum += ' ' + status;
  if (total) sum += ' $' + total;
  return sum;
}

function formatNestedField(key: string, val: unknown): string {
  if (Array.isArray(val)) {
    const preview = val.slice(0, 2).map(v =>
      (v && typeof v === 'object') ? (v.name || v.id || '?') : v
    ).join(', ');
    return key + '[' + val.length + ']: ' + preview + (val.length > 2 ? '...' : '');
  }
  const nm = val.name || val.id || '';
  return key + ': ' + nm;
}

function toTree(items: Record<string, unknown>[], name = 'data'): string {
  const out = [name + '[' + items.length + ']:'];
  const idKey = TREE_ID_KEYS.find(k => items[0]?.[k]);
  const max = Math.min(items.length, TREE_MAX_ITEMS);

  for (let i = 0; i < max; i++) {
    const item = items[i];
    const isLast = i === max - 1;
    const pfx = isLast ? 'L ' : '| ';
    out.push(pfx + formatTreeSummary(item, idKey, i));

    const cpfx = isLast ? '  ' : '| ';
    const nested = Object.entries(item)
      .filter(([k, v]) => typeof v === 'object' && v !== null && !TREE_SKIP_KEYS.has(k))
      .slice(0, 3);

    for (let j = 0; j < nested.length; j++) {
      const cp = cpfx + (j === nested.length - 1 ? 'L ' : '| ');
      out.push(cp + formatNestedField(nested[j][0], nested[j][1]));
    }
  }

  if (items.length > TREE_MAX_ITEMS) out.push('... +' + (items.length - TREE_MAX_ITEMS) + ' more');
  return out.join('\n');
}

function toTreeTOON(obj: Record<string, unknown>, indent = ''): string {
  const lines = [];
  const entries = Object.entries(obj as Record<string, unknown>);

  for (let i = 0; i < entries.length; i++) {
    const [key, val] = entries[i];
    const isLast = i === entries.length - 1;
    const branch = indent + (isLast ? '└── ' : '├── ');
    const childIndent = indent + (isLast ? '    ' : '│   ');

    if (val === null || val === undefined) continue;
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
      const keys = Object.keys(val[0]).slice(0, 8);
      lines.push(branch + key + '[' + val.length + ']{' + keys.join(',') + '}:');
      for (const item of val.slice(0, 10)) {
        lines.push(childIndent + '  ' + keys.map(k => escapeField(item[k])).join('|'));
      }
      if (val.length > 10) lines.push(childIndent + '  ... +' + (val.length - 10) + ' more');
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      const summary = formatObjectSummary(val);
      lines.push(branch + key + ': ' + summary);
      const nested = toTreeTOON(val, childIndent);
      if (nested) lines.push(nested);
    } else {
      lines.push(branch + key + ': ' + escapeField(val));
    }
  }
  return lines.join('\n');
}

function formatObjectSummary(obj: Record<string, unknown>): string {
  const id = TREE_ID_KEYS.map(k => obj[k]).find(Boolean) || '';
  const name = obj.name || obj.title || '';
  if (id && name && id !== name) return id + ' (' + name + ')';
  return String(id || name || '{...}');
}

export function objectToTOON(obj: Record<string, unknown>, name = 'data'): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return name + ': {}';

  const lines = entries.map(([k, v]) => {
    if (typeof v === 'object' && !Array.isArray(v)) {
      return '  ' + k + ': ' + formatObjectSummary(v);
    }
    return '  ' + k + ': ' + escapeField(v);
  });

  return name + ':\n' + lines.join('\n');
}

export function maybeObjectToTOON(obj: Record<string, unknown>, name = 'data'): string {
  const depth = getDepth(obj);
  const hasArrays = Object.values(obj).some(v => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object');
  if (depth > 2 || hasArrays) {
    const summary = formatObjectSummary(obj);
    return summary + '\n' + toTreeTOON(obj, '');
  }
  return objectToTOON(obj, name);
}

export function maybeToTOON(value: unknown): string | null {
  if (!Array.isArray(value) || !isUniformArray(value)) return null;
  const depth = getDepth(value);
  const fields = countFields(value[0]);
  if (depth > 3 || fields > 15) return toTreeTOONList(value);
  return toTOON(value);
}

function toTreeTOONList(items: Record<string, unknown>[], name = 'data'): string {
  const out = [name + '[' + items.length + ']:'];
  const max = Math.min(items.length, TREE_MAX_ITEMS);

  for (let i = 0; i < max; i++) {
    const item = items[i];
    out.push(formatTreeSummary(item, TREE_ID_KEYS.find(k => item[k]), i));
    out.push(toTreeTOON(item, '  '));
  }
  if (items.length > TREE_MAX_ITEMS) out.push('... +' + (items.length - TREE_MAX_ITEMS) + ' more');
  return out.join('\n');
}

export function summarizeResult(value: unknown, opts: TruncateOptions = {}): SummarizedResult {
  const rawJson = JSON.stringify(value) ?? '';
  const rawBytes = rawJson.length;

  if (!opts.enabled) {
    return { value, truncated: false, rawBytes, truncatedBytes: rawBytes };
  }

  const summarized = summarizeObject(value, opts, 0, new WeakSet());
  const truncatedJson = JSON.stringify(summarized) ?? '';
  const truncatedBytes = truncatedJson.length;
  const truncated = truncatedBytes !== rawBytes;

  return {
    value: summarized,
    truncated,
    originalSize: truncated ? formatBytes(rawBytes) : undefined,
    rawBytes,
    truncatedBytes,
  };
}

function findCleanCut(text: string, target: number, tolerance = 200): number {
  const idx = text.lastIndexOf('\n', target);
  return idx >= target - tolerance ? idx + 1 : target;
}

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

export function formatFileResult(result: unknown, code?: string, prefix?: string): string {
  if (result === undefined || result === null) return 'undefined';

  if (Array.isArray(result) && result.every(r => typeof r === 'string')) {
    const sliceMatch = code?.match(/\.slice\s*\(\s*(\d+)/);
    const offset = sliceMatch ? parseInt(sliceMatch[1], 10) : 0;
    const formatted = result.map((line, i) => {
      const numbered = `${offset + i + 1}: ${line}`;
      return numbered.length > MAX_LINE_WIDTH ? numbered.slice(0, MAX_LINE_WIDTH - 3) + '...' : numbered;
    }).join('\n');
    return prefix ? prefix + formatted : formatted;
  }

  if (typeof result === 'string') {
    const formatted = result.split('\n').map(line => line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH - 3) + '...' : line).join('\n');
    return prefix ? prefix + formatted : formatted;
  }

  const json = JSON.stringify(result, null, 2);
  return prefix ? prefix + json : json;
}

export function truncateString(str: string, maxLen: number, matchPos?: number): string {
  if (str.length <= maxLen) return str;

  if (matchPos !== undefined && matchPos >= 0) {
    const beforeLen = Math.floor(maxLen / 3);
    const afterLen = maxLen - beforeLen - 3;
    const start = Math.max(0, matchPos - beforeLen);
    const end = Math.min(str.length, matchPos + afterLen);
    return (start > 0 ? "..." : "") + str.slice(start, end) + (end < str.length ? "..." : "");
  }

  const contentLen = maxLen - 6;
  const startLen = Math.floor(contentLen * 0.6);
  const endLen = contentLen - startLen;
  return str.slice(0, startLen) + "..." + str.slice(-endLen);
}

export function cleanLine(line: string, maxLen: number = 100, pattern?: string): string {
  let cleaned = line.replace(/^\d+:\s*/, "").replace(/\s+/g, " ").trim();
  let matchPos;
  if (pattern) {
    const idx = cleaned.toLowerCase().indexOf(pattern.toLowerCase());
    if (idx >= 0) matchPos = idx;
  }
  return truncateString(cleaned, maxLen, matchPos);
}

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

export function truncateJsonUtf8Safe(value: unknown, maxBytes: number): string {
  return truncateUtf8Safe(JSON.stringify(value) ?? 'null', maxBytes, '... [truncated]');
}
