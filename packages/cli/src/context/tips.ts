/**
 * Tool Tips - Generic Rules
 */

import type { ToolMeta } from "../tools/meta.js";
import { getAccessCount, isStale } from "./files.js";
import { getAllVariables, getVariable } from "./variables.js";

import { createDebugger } from "../utils/debug.js";
import { errorTips, eventTips, tipMessages } from "./messages/index.js";

const debug = createDebugger("tips");

// ============================================================================
// Types
// ============================================================================

export type RecentTool = { tool: string; file?: string };

export interface TipContext {
  meta: ToolMeta;
  params: Record<string, unknown>;
  recentTools: RecentTool[];
  filePath?: string;
  // Result metadata (provided by handler via _meta)
  resultMeta?: {
    truncated?: boolean;
    storedAs?: string;
  };
}

interface TipRule {
  test: (ctx: TipContext) => boolean;
  message: (ctx: TipContext) => string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Find variables not accessed in last N minutes */
function getUnusedVars(maxAgeMs = 3 * 60 * 1000): string[] {
  const now = Date.now();
  const unused: string[] = [];
  for (const name of Object.keys(getAllVariables())) {
    const stored = getVariable(name);
    const accessedAt = stored?.accessedAt || stored?.timestamp || 0;
    if (now - accessedAt > maxAgeMs) {
      unused.push(name);
    }
  }
  return unused;
}

function lastTool(tools: RecentTool[]): string | undefined {
  return tools[tools.length - 1]?.tool;
}

function lastEditedFile(tools: RecentTool[]): string | undefined {
  for (let i = tools.length - 1; i >= 0; i--) {
    if ((tools[i].tool === 'mcx_file' || tools[i].tool === 'mcx_write') && tools[i].file) {
      return tools[i].file;
    }
  }
  return undefined;
}

function countRecent(tools: RecentTool[], name: string, n = 5): number {
  return tools.slice(-n).filter(t => t.tool === name).length;
}

// ============================================================================
// Generic Rules (no tool-specific cases)
// ============================================================================

const RULES: TipRule[] = [
  // === File access patterns (security) ===
  // NOTE: Skip stale warnings after successful write (auto-reload handles it)
  {
    test: ctx => ctx.meta.reads && ctx.filePath !== undefined && isStale(ctx.filePath) && ctx.params?.write !== true,
    message: tipMessages.staleRead,
  },
  {
    test: ctx => ctx.meta.writes && ctx.filePath !== undefined && isStale(ctx.filePath) && ctx.params?.write !== true,
    message: tipMessages.staleWrite,
  },

  // === Tool sequence patterns (efficiency) ===
  {
    test: ctx => ctx.params?.write === true && ctx.filePath,
    message: tipMessages.noRereadAfterEdit,
  },
  {
    test: ctx => ctx.meta.reads && lastTool(ctx.recentTools) === 'mcx_write' && ctx.filePath && lastEditedFile(ctx.recentTools) === ctx.filePath,
    message: tipMessages.noRereadAfterWrite,
  },

  // === Execution patterns ===
  {
    test: ctx => ctx.meta.executes && typeof ctx.params.shell === 'string' && ctx.params.shell.includes('&&'),
    message: tipMessages.chainedCommands,
  },

  // === Retry detection ===
  {
    test: ctx => {
      const last3 = ctx.recentTools.slice(-3);
      return last3.length === 3 && last3.every(t => t === ctx.recentTools[ctx.recentTools.length - 1]);
    },
    message: tipMessages.sameTool3x,
  },

  // === Edit patterns (writes capability) ===
  {
    test: ctx => ctx.meta.writes && lastTool(ctx.recentTools) === 'mcx_file',
    message: tipMessages.backToBackEdits,
  },
  {
    test: ctx => ctx.meta.writes && countRecent(ctx.recentTools, 'mcx_file') >= 2 && 
                 countRecent(ctx.recentTools, 'mcx_execute') >= 1,
    message: tipMessages.editBuildCycle,
  },

  // === Search patterns (error prevention) ===
  {
    test: ctx => ctx.meta.searches && typeof ctx.params.query === 'string' && 
                 ctx.params.query.includes('**'),
    message: tipMessages.recursiveGlob,
  },
  {
    test: ctx => ctx.meta.searches && typeof ctx.params.pattern === 'string' &&
                 ctx.params.pattern.includes('/') && !ctx.params.glob,
    message: tipMessages.pathInPattern,
  },

  // === Truncation hints ===
  {
    test: ctx => ctx.meta.executes && ctx.params.truncate === false,
    message: tipMessages.fullOutputRequested,
  },
  {
    test: ctx => ctx.resultMeta?.truncated && ctx.resultMeta?.storedAs,
    message: ctx => tipMessages.truncatedResult(ctx.resultMeta!.storedAs!),
  },
];

// ============================================================================
// Main Function
// ============================================================================

/**
 * Get tips for a tool invocation
 * One loop, all rules, all tools
 */
export function getTips(ctx: TipContext): string[] {
  return RULES
    .filter(rule => rule.test(ctx))
    .map(rule => rule.message(ctx));
}

/**
 * Get first tip only (for minimal output)
 */
export function getFirstTip(ctx: TipContext): string | null {
  for (const rule of RULES) {
    if (rule.test(ctx)) return rule.message(ctx);
  }
  return null;
}

// ============================================================================
// Re-export messages from centralized location
// ============================================================================

export { errorTips, eventTips };
