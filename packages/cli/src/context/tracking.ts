/**
 * Tool Usage Tracking
 * 
 * Tracks tool usage patterns for intelligent suggestions.
 * Manages proximity context for search result boosting.
 * Extracted from serve.ts tracking functions.
 */

import type { SessionWorkflow } from "../tools/types.js";

// ============================================================================
// Constants
// ============================================================================

const MAX_RECENT_TOOLS = 10;
const MAX_RECENT_FILES = 20;
const MAX_RECENT_PATTERNS = 10;
const WORKFLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// State
// ============================================================================

const workflow: SessionWorkflow = {
  lastTools: [],
  proximityContext: {
    recentFiles: [],
    recentPatterns: [],
  },
};

// ============================================================================
// Tool Usage Tracking
// ============================================================================

/**
 * Record a tool invocation for pattern analysis.
 */
export function trackToolUsage(tool: string, file?: string): void {
  const now = Date.now();
  
  // Add to recent tools
  workflow.lastTools.push({ tool, file, timestamp: now });
  
  // Keep only recent entries
  if (workflow.lastTools.length > MAX_RECENT_TOOLS) {
    workflow.lastTools.shift();
  }
  
  // Update proximity context if file involved
  if (file) {
    updateProximityContext([file], []);
  }
  
  // Clean old entries
  cleanupOldEntries();
}

/**
 * Get the last N tools used.
 */
export function getRecentTools(n: number = 5): Array<{ tool: string; file?: string }> {
  return workflow.lastTools.slice(-n).map(t => ({ tool: t.tool, file: t.file }));
}

// ============================================================================
// Next Tool Suggestions
// ============================================================================

interface ToolSuggestion {
  tool: string;
  hint: string;
}

const TOOL_FLOW_MAP: Record<string, ToolSuggestion[]> = {
  mcx_find: [
    { tool: "mcx_grep", hint: "search content in found files" },
    { tool: "mcx_file", hint: "process matched file" },
  ],
  mcx_grep: [
    { tool: "mcx_file", hint: "read full file context" },
    { tool: "mcx_edit", hint: "modify matched lines" },
  ],
  mcx_file: [
    { tool: "mcx_edit", hint: "edit file content" },
    { tool: "mcx_grep", hint: "search within file" },
  ],
  mcx_search: [
    { tool: "mcx_execute", hint: "run discovered method" },
    { tool: "mcx_file", hint: "read source file" },
  ],
  mcx_execute: [
    { tool: "mcx_search", hint: "explore more methods" },
  ],
  mcx_fetch: [
    { tool: "mcx_search", hint: "search indexed content" },
  ],
};

/**
 * Suggest next tool based on workflow pattern.
 */
export function suggestNextTool(currentTool: string): string {
  const suggestions = TOOL_FLOW_MAP[currentTool];
  if (!suggestions || suggestions.length === 0) return "";
  
  const hint = suggestions[0];
  return `\n→ Next: ${hint.tool} (${hint.hint})`;
}

/**
 * Get all suggestions for a tool.
 */
export function getToolSuggestions(tool: string): ToolSuggestion[] {
  return TOOL_FLOW_MAP[tool] || [];
}

// ============================================================================
// Proximity Context
// ============================================================================

/**
 * Update proximity context with recent files and patterns.
 * Used for boosting search results near recently accessed content.
 */
export function updateProximityContext(files: string[], patterns: string[]): void {
  const ctx = workflow.proximityContext;
  
  // Add files (most recent first)
  for (const f of files) {
    const idx = ctx.recentFiles.indexOf(f);
    if (idx >= 0) ctx.recentFiles.splice(idx, 1);
    ctx.recentFiles.unshift(f);
  }
  
  // Add patterns
  for (const p of patterns) {
    const idx = ctx.recentPatterns.indexOf(p);
    if (idx >= 0) ctx.recentPatterns.splice(idx, 1);
    ctx.recentPatterns.unshift(p);
  }
  
  // Trim to max
  if (ctx.recentFiles.length > MAX_RECENT_FILES) {
    ctx.recentFiles.length = MAX_RECENT_FILES;
  }
  if (ctx.recentPatterns.length > MAX_RECENT_PATTERNS) {
    ctx.recentPatterns.length = MAX_RECENT_PATTERNS;
  }
}

/**
 * Get proximity boost score for a file path.
 * Returns 0-1 where 1 = most recently accessed.
 */
export function getProximityScore(filePath: string): number {
  const ctx = workflow.proximityContext;
  const idx = ctx.recentFiles.indexOf(filePath);
  
  if (idx < 0) return 0;
  
  // Linear decay: first = 1.0, last = 0.1
  return 1 - (idx / MAX_RECENT_FILES) * 0.9;
}

/**
 * Get recent files for context.
 */
export function getRecentFiles(): string[] {
  return [...workflow.proximityContext.recentFiles];
}

/**
 * Get recent patterns for context.
 */
export function getRecentPatterns(): string[] {
  return [...workflow.proximityContext.recentPatterns];
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanupOldEntries(): void {
  const cutoff = Date.now() - WORKFLOW_TIMEOUT_MS;
  workflow.lastTools = workflow.lastTools.filter(t => t.timestamp > cutoff);
}

/**
 * Reset all tracking state.
 */
export function resetTracking(): void {
  workflow.lastTools = [];
  workflow.proximityContext.recentFiles = [];
  workflow.proximityContext.recentPatterns = [];
}

// ============================================================================
// Inefficiency Detection
// ============================================================================

interface InefficiencyHint {
  tool: string;
  hint: string;
}

const INEFFICIENCY_PATTERNS: Array<{
  pattern: RegExp;
  suggestion: InefficiencyHint;
}> = [
  {
    pattern: /cat\s+\S+/,
    suggestion: { tool: "mcx_file", hint: "use mcx_file instead of cat" },
  },
  {
    pattern: /grep\s+/,
    suggestion: { tool: "mcx_grep", hint: "use mcx_grep instead of grep" },
  },
  {
    pattern: /find\s+\./,
    suggestion: { tool: "mcx_find", hint: "use mcx_find instead of find" },
  },
  {
    pattern: /curl\s+|wget\s+/,
    suggestion: { tool: "mcx_fetch", hint: "use mcx_fetch for URL fetching" },
  },
];

/**
 * Detect inefficient tool usage and suggest alternatives.
 */
export function detectInefficiency(tool: string, command?: string): InefficiencyHint | null {
  if (!command) return null;
  
  for (const { pattern, suggestion } of INEFFICIENCY_PATTERNS) {
    if (pattern.test(command)) {
      return suggestion;
    }
  }
  
  return null;
}

// ============================================================================
// Method Usage / Frecency (Adapter Methods)
// ============================================================================

const METHOD_USAGE_CAP = 500;
const METHOD_PATTERN = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

const methodUsage = new Map<string, number>();

/** Track adapter method calls in code (frecency) */
export function trackMethodUsage(code: string, adapters: Record<string, unknown>): void {
  METHOD_PATTERN.lastIndex = 0;
  let match;
  while ((match = METHOD_PATTERN.exec(code)) !== null) {
    const [, adapter, method] = match;
    if (adapters && typeof adapters === 'object' && adapter in adapters) {
      const key = `${adapter}.${method}`;
      methodUsage.set(key, (methodUsage.get(key) || 0) + 1);
    }
  }
  // Evict LFU if over cap
  if (methodUsage.size > METHOD_USAGE_CAP) {
    let minKey = '', minVal = Infinity;
    for (const [k, v] of methodUsage) {
      if (v < minVal) { minKey = k; minVal = v; }
    }
    if (minKey) methodUsage.delete(minKey);
  }
}

/** Get frecency score for sorting */
export function getMethodFrecency(adapter: string, method: string): number {
  return methodUsage.get(`${adapter}.${method}`) || 0;
}

/** Get top N methods for stats display */
export function getTopMethods(n = 5): Array<[string, number]> {
  return [...methodUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ============================================================================
// Session Stats - Single Source of Truth
// ============================================================================

interface ToolStats {
  calls: number;
  chars: number;   // bytes sent to LLM (after truncation)
  raw: number;     // original bytes (before truncation)
  errors: number;
}

interface StoredVarMeta {
  path?: string;
  size: number;
  storedAt: number;
}

const sessionStats = {
  // Token tracking
  byTool: new Map<string, ToolStats>(),
  totalCalls: 0,
  totalChars: 0,
  totalRaw: 0,
  sessionStart: Date.now(),

  // I/O tracking (consolidated from loose variables)
  fsBytesRead: 0,
  fsFilesRead: 0,
  networkBytesIn: 0,
  networkBytesOut: 0,
  networkRequests: 0,

  // Cache tracking
  cacheHits: 0,
  cacheBytesSaved: 0,

  // Variable tracking
  storedVars: new Map<string, StoredVarMeta>(),
};

// ============================================================================
// Token Tracking
// ============================================================================

/**
 * Track tool output for efficiency stats.
 */
export function trackToolOutput(
  toolName: string,
  responseChars: number,
  rawBytes: number,
  isError = false
): void {
  const stats = sessionStats.byTool.get(toolName) || { calls: 0, chars: 0, raw: 0, errors: 0 };
  stats.calls++;
  stats.chars += responseChars;
  stats.raw += rawBytes;
  if (isError) stats.errors++;

  sessionStats.byTool.set(toolName, stats);
  sessionStats.totalCalls++;
  sessionStats.totalChars += responseChars;
  sessionStats.totalRaw += rawBytes;
}

// ============================================================================
// I/O Tracking (preserving existing function names)
// ============================================================================

/** Track sandbox I/O (called after JS/Python execution) */
export function trackSandboxIO(tracking?: {
  fsBytes?: number;
  fsCount?: number;
  netBytes?: number;
  netCount?: number;
}): void {
  if (!tracking) return;
  sessionStats.fsBytesRead += tracking.fsBytes ?? 0;
  sessionStats.fsFilesRead += tracking.fsCount ?? 0;
  sessionStats.networkBytesIn += tracking.netBytes ?? 0;
  sessionStats.networkRequests += tracking.netCount ?? 0;
}

/** Track network bytes (called after fetch) - name preserved for fetch.ts */
export function trackNetworkBytes(bytesIn: number, bytesOut: number = 0): void {
  sessionStats.networkBytesIn += bytesIn;
  sessionStats.networkBytesOut += bytesOut;
  sessionStats.networkRequests++;
}

/** Track filesystem bytes (called after file read) */
export function trackFsBytes(bytes: number): void {
  sessionStats.fsBytesRead += bytes;
  sessionStats.fsFilesRead++;
}

// ============================================================================
// Cache Tracking
// ============================================================================

/** Track cache hit (URL cache, finder cache) */
export function trackCacheHit(bytesSaved: number): void {
  sessionStats.cacheHits++;
  sessionStats.cacheBytesSaved += bytesSaved;
}

// ============================================================================
// Variable Tracking
// ============================================================================

/** Track stored variable */
export function trackStoredVar(name: string, size: number, path?: string): void {
  sessionStats.storedVars.set(name, { path, size, storedAt: Date.now() });
}

/** Remove tracked variable */
export function untrackStoredVar(name: string): void {
  sessionStats.storedVars.delete(name);
}

// ============================================================================
// Session Stats Getter (replaces getIOStats)
// ============================================================================

/**
 * Get all session stats. Returns snapshot.
 */
export function getSessionStats() {
  let storedVarsBytes = 0;
  for (const v of sessionStats.storedVars.values()) {
    storedVarsBytes += v.size;
  }

  return {
    // Token stats
    byTool: [...sessionStats.byTool.entries()] as Array<[string, ToolStats]>,
    totalCalls: sessionStats.totalCalls,
    totalChars: sessionStats.totalChars,
    totalRaw: sessionStats.totalRaw,
    sessionMs: Date.now() - sessionStats.sessionStart,

    // I/O stats
    fsBytesRead: sessionStats.fsBytesRead,
    fsFilesRead: sessionStats.fsFilesRead,
    networkBytesIn: sessionStats.networkBytesIn,
    networkRequests: sessionStats.networkRequests,

    // Cache stats
    cacheHits: sessionStats.cacheHits,
    cacheBytesSaved: sessionStats.cacheBytesSaved,

    // Variable stats
    storedVarsCount: sessionStats.storedVars.size,
    storedVarsBytes,
  };
}

/** Get I/O stats (backwards compatible, prefer getSessionStats) */
export function getIOStats() {
  return {
    fsBytesRead: sessionStats.fsBytesRead,
    fsFilesRead: sessionStats.fsFilesRead,
    networkBytesIn: sessionStats.networkBytesIn,
    networkRequests: sessionStats.networkRequests,
  };
}

// ============================================================================
// Reset (for testing)
// ============================================================================

/** Reset all session stats */
export function resetSessionStats(): void {
  sessionStats.byTool.clear();
  sessionStats.totalCalls = 0;
  sessionStats.totalChars = 0;
  sessionStats.totalRaw = 0;
  sessionStats.sessionStart = Date.now();
  sessionStats.fsBytesRead = 0;
  sessionStats.fsFilesRead = 0;
  sessionStats.networkBytesIn = 0;
  sessionStats.networkBytesOut = 0;
  sessionStats.networkRequests = 0;
  sessionStats.cacheHits = 0;
  sessionStats.cacheBytesSaved = 0;
  sessionStats.storedVars.clear();
}

/** Reset I/O stats only (backwards compatible) */
export function resetIOStats(): void {
  sessionStats.fsBytesRead = 0;
  sessionStats.fsFilesRead = 0;
  sessionStats.networkBytesIn = 0;
  sessionStats.networkBytesOut = 0;
  sessionStats.networkRequests = 0;
}
