/**
 * Session Variables Management
 * 
 * Manages $result, $stored variables, and file variables.
 * Extracted from serve.ts session state handling.
 */

import type { SessionVariables, StoredVariable } from "../tools/types.js";

// Singleton state
const state: SessionVariables = {
  stored: new Map(),
  lastResult: undefined,
};

// ============================================================================
// Variable Access
// ============================================================================

/**
 * Get a stored variable by name.
 * Names can be with or without $ prefix.
 */
export function getVariable(name: string): StoredVariable | undefined {
  const key = name.startsWith("$") ? name.slice(1) : name;
  return state.stored.get(key);
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
  state.stored.set(key, {
    value,
    type,
    path: meta?.path,
    lineCount: meta?.lineCount,
    timestamp: Date.now(),
  });
}

/**
 * Delete a stored variable.
 */
export function deleteVariable(name: string): boolean {
  const key = name.startsWith("$") ? name.slice(1) : name;
  return state.stored.delete(key);
}

/**
 * Clear all stored variables.
 */
export function clearVariables(): void {
  state.stored.clear();
  state.lastResult = undefined;
}

/**
 * Get all variable names.
 */
export function getVariableNames(): string[] {
  return Array.from(state.stored.keys());
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
 */
export function checkFileVariable(name: string, currentMtime?: number): StoredVariable | null {
  const v = getVariable(name);
  if (!v || v.type !== "file") return null;
  
  // If we can't check mtime, assume valid
  if (currentMtime === undefined) return v;
  
  // Stale if file was modified after variable was stored
  if (currentMtime > v.timestamp) return null;
  
  return v;
}

/**
 * Store a file variable with metadata.
 */
export function setFileVariable(
  name: string,
  content: { text: string; lines: string[] },
  path: string
): void {
  setVariable(name, content, "file", {
    path,
    lineCount: content.lines.length,
  });
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
}

export function getVariableSummary(): VariableSummary[] {
  const now = Date.now();
  return Array.from(state.stored.entries()).map(([name, v]) => ({
    name: `$${name}`,
    type: v.type,
    size: estimateSize(v.value),
    lineCount: v.lineCount,
    path: v.path,
    age: now - v.timestamp,
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
