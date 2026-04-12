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
