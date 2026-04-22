/**
 * Session Variables Management
 * 
 * Manages $result, $stored variables, and file variables.
 * Extracted from serve.ts session state handling.
 */

import type { SessionVariables, StoredVariable } from "../tools/types.js";
import { getStoredAt, getEditedAt } from "./files.js";
import { MAP_MAX_ENTRIES } from "../tools/constants.js";

// Singleton state
const state: SessionVariables = {
  stored: new Map(),
  lastResult: undefined,
};

// File variable mapping (O(1) bidirectional lookup)
const fileVarByPath = new Map<string, string>();  // path -> varName
const pathByFileVar = new Map<string, string>();  // varName -> path

/**
 * Get the singleton state for use by create.ts
 */
export function getState(): SessionVariables {
  return state;
}

// ============================================================================
// Variable Access
// ============================================================================

/**
 * Get a stored variable by name.
 * Names can be with or without $ prefix.
 * Updates accessedAt for compression tracking.
 */
export function getVariable(name: string): StoredVariable | undefined {
  const key = name.startsWith("$") ? name.slice(1) : name;
  const stored = state.stored.get(key);
  if (stored) {
    stored.accessedAt = Date.now();
  }
  return stored;
}

/**
 * Evict least recently used variable if over limit.
 * Returns evicted key or null.
 */
function evictLRU(): string | null {
  if (state.stored.size < MAP_MAX_ENTRIES) return null;
  
  // Find oldest by accessedAt (guaranteed to exist since size >= MAX)
  let oldestKey = "";
  let oldestTime = Infinity;
  for (const [key, v] of state.stored) {
    if (v.accessedAt >= oldestTime) continue;
    oldestTime = v.accessedAt;
    oldestKey = key;
  }
  deleteVariable(oldestKey);
  return oldestKey;
}

/**
 * Set a stored variable.
 */
export function setVariable(
  name: string, 
  value: unknown, 
  type: StoredVariable["type"] = "result",
  meta?: { path?: string; lineCount?: number }
): void {
  const key = name.startsWith("$") ? name.slice(1) : name;
  
  // Evict LRU if at limit and this is a new key
  if (!state.stored.has(key)) evictLRU();
  
  const now = Date.now();
  const originalSize = JSON.stringify(value).length;
  state.stored.set(key, {
    value,
    type,
    path: meta?.path,
    lineCount: meta?.lineCount,
    timestamp: now,
    accessedAt: now,
    originalSize,
    compressed: false,
  });
}

/**
 * Delete a stored variable.
 */
export function deleteVariable(name: string): boolean {
  const key = name.startsWith("$") ? name.slice(1) : name;
  const stored = state.stored.get(key);
  if (stored?.path) fileVarByPath.delete(stored.path);
  pathByFileVar.delete(key);
  return state.stored.delete(key);
}

/**
 * Clear all stored variables.
 */
export function clearVariables(): void {
  state.stored.clear();
  state.lastResult = undefined;
  fileVarByPath.clear();
  pathByFileVar.clear();
}

/**
 * Get all variable names.
 */
export function getVariableNames(): string[] {
  return Array.from(state.stored.keys());
}

/**
 * Get all variables as a plain object.
 * Returns { name: value } format.
 */
export function getAllVariables(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, stored] of state.stored) {
    result[key] = stored.value;
  }
  return result;
}

/**
 * Get all variables with $ prefix for sandbox injection.
 * Returns { $name: value } format.
 */
export function getAllPrefixed(): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, stored] of state.stored) {
    result[`$${key}`] = stored.value;
  }
  return result;
}

// ============================================================================
// Compression
// ============================================================================

/**
 * Compress a variable to save memory/context.
 * Replaces arrays with summary, keeps first few items.
 */
export function compress(name: string, keepItems = 3): boolean {
  const key = name.startsWith("$") ? name.slice(1) : name;
  const stored = state.stored.get(key);
  if (!stored || !Array.isArray(stored.value)) return false;
  if (stored.compressed) return false;

  const value = stored.value;
  const summary = {
    __compressed__: true,
    type: 'array',
    totalItems: value.length,
    sample: value.slice(0, keepItems),
    keys: value.length > 0 && typeof value[0] === 'object'
      ? Object.keys(value[0] || {})
      : undefined,
  };

  stored.value = summary;
  stored.compressed = true;
  return true;
}

/**
 * Compress old variables that haven't been accessed recently.
 * @param maxAgeMs - Max age in ms since last access (default: 5 minutes)
 * @param minSize - Minimum size in chars to compress (default: 1000)
 * @param isIndexed - Optional function to check if var is indexed (safe to compress immediately)
 */
export function compressStale(
  maxAgeMs = 5 * 60 * 1000,
  minSize = 1000,
  isIndexed?: (varName: string) => boolean
): string[] {
  const now = Date.now();
  const compressed: string[] = [];

  for (const [name, stored] of state.stored) {
    if (stored.compressed) continue;

    // If indexed in FTS5 -> safe to compress (data accessible via search)
    if (isIndexed?.(name)) {
      if (compress(name)) compressed.push(name);
      continue;
    }

    // Not indexed -> use age/size heuristics
    const size = stored.originalSize || 0;
    const accessedAt = stored.accessedAt || stored.timestamp;
    if (size < minSize) continue;
    if (now - accessedAt < maxAgeMs) continue;
    if (compress(name)) compressed.push(name);
  }

  return compressed;
}

// ============================================================================
// Last Result ($result)
// ============================================================================

/**
 * Get the last execution result.
 */
export function getLastResult(): unknown {
  return state.lastResult;
}

/**
 * Set the last execution result.
 * Also stores as $result variable.
 */
export function setLastResult(value: unknown): void {
  state.lastResult = value;
  setVariable("result", value, "result");
}

// ============================================================================
// File Variables
// ============================================================================

/**
 * Check if a file variable is stale (file was modified since storage).
 * Returns the variable if valid, null if stale.
 * Uses files.ts tracking system (getStoredAt/getEditedAt).
 */
export function checkFileVariable(name: string): StoredVariable | null {
  const v = getVariable(name);
  if (!v || v.type !== "file" || !v.path) return null;
  
  const storedAt = getStoredAt(v.path);
  const editedAt = getEditedAt(v.path);
  
  // Stale if edited after stored
  if (storedAt && editedAt && editedAt > storedAt) return null;
  
  return v;
}

/**
 * Store a file variable with metadata.
 */
export function setFileVariable(
  name: string,
  content: { text: string; lines?: string[] },
  path: string
): void {
  const key = name.startsWith("$") ? name.slice(1) : name;
  setVariable(name, content, "file", {
    path,
    lineCount: content.lines?.length,
  });
  fileVarByPath.set(path, key);
  pathByFileVar.set(key, path);
}

/**
 * Get variable name for a path (O(1) lookup).
 */
export function getFileVarByPath(path: string): string | undefined {
  return fileVarByPath.get(path);
}

/**
 * Get path for a variable name (O(1) lookup).
 */
export function getPathByFileVar(varName: string): string | undefined {
  const key = varName.startsWith("$") ? varName.slice(1) : varName;
  return pathByFileVar.get(key);
}

/**
 * Clear only file variables (type: "file").
 */
export function clearFileVariables(): number {
  let cleared = 0;
  for (const [key, val] of state.stored) {
    if (val.type !== "file") continue;
    if (val.path) fileVarByPath.delete(val.path);
    pathByFileVar.delete(key);
    state.stored.delete(key);
    cleared++;
  }
  return cleared;
}

// ============================================================================
// Variable Summary (for mcx_stats)
// ============================================================================

export interface VariableSummary {
  name: string;
  type: StoredVariable["type"];
  size: number;        // Approximate size in bytes
  lineCount?: number;
  path?: string;
  age: number;         // Age in ms
  compressed?: boolean;
}

export function getVariableSummary(): VariableSummary[] {
  const now = Date.now();
  return Array.from(state.stored.entries()).map(([name, v]) => ({
    name: `${name}`,
    type: v.type,
    size: estimateSize(v.value),
    lineCount: v.lineCount,
    path: v.path,
    age: now - v.timestamp,
    compressed: v.compressed,
  }));
}

function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number") return 8;
  if (typeof value === "boolean") return 1;
  if (Array.isArray(value)) return value.length * 50; // rough estimate
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 1000; // fallback
    }
  }
  return 0;
}
