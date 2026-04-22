/**
 * Tool Tips - Generic Rules
 */

import type { ToolMeta } from "../tools/meta.js";
import { getAccessCount, isStale } from "./files.js";
import { getAllVariables, getVariable } from "./variables.js";
import { wasLastToolSuccessful } from "./tracking.js";

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
    message: () => `File was modified since last store. Re-read recommended.`,
  },
  {
    test: ctx => ctx.meta.writes && ctx.filePath !== undefined && isStale(ctx.filePath) && ctx.params?.write !== true,
    message: () => `Warning: File changed since last read. Verify before editing.`,
  },

  // === Tool sequence patterns (efficiency) ===
  // Removed: tip is already in success message, was firing on errors too
  // {
  //   test: ctx => ctx.params?.write === true && ctx.filePath,
  //   message: () => `No need to re-read after edit. Changes confirmed.`,
  // },
  {
    test: ctx => ctx.meta.reads && wasLastToolSuccessful() && lastTool(ctx.recentTools) === 'mcx_write' && ctx.filePath && lastEditedFile(ctx.recentTools) === ctx.filePath,
    message: () => `No need to re-read after write. Content confirmed.`,
  },

  // === Execution patterns ===
  {
    test: ctx => ctx.meta.executes && typeof ctx.params.shell === 'string' && ctx.params.shell.includes('&&'),
    message: () => `Chained commands detected. Consider splitting for better error handling.`,
  },

  // === Retry detection ===
  {
    test: ctx => {
      const last3 = ctx.recentTools.slice(-3);
      return last3.length === 3 && last3.every(t => t === ctx.recentTools[ctx.recentTools.length - 1]);
    },
    message: () => `Same tool 3x in a row. Check if approach needs adjustment.`,
  },

  // === Edit patterns (writes capability) ===
  {
    test: ctx => ctx.meta.writes && wasLastToolSuccessful() && (lastTool(ctx.recentTools) === 'mcx_file' || lastTool(ctx.recentTools) === 'mcx_write'),
    message: () => `Back-to-back edits. Consider batching changes.`,
  },
  {
    test: ctx => ctx.meta.writes && wasLastToolSuccessful() && (countRecent(ctx.recentTools, 'mcx_file') + countRecent(ctx.recentTools, 'mcx_write')) >= 2 && 
                 countRecent(ctx.recentTools, 'mcx_execute') >= 1,
    message: () => `Edit->build->edit cycle. Batch all edits first, then build once.`,
  },

  // === Search patterns (error prevention) ===
  {
    test: ctx => ctx.meta.searches && typeof ctx.params.query === 'string' && 
                 ctx.params.query.includes('**'),
    message: () => `Recursive ** not supported. Use fuzzy: "*.ts", "dir/", or partial name.`,
  },
  {
    test: ctx => ctx.meta.searches && typeof ctx.params.pattern === 'string' &&
                 ctx.params.pattern.includes('/') && !ctx.params.glob,
    message: () => `Path in pattern? Use glob param for directory filter.`,
  },

  // === Truncation hints ===
  {
    test: ctx => ctx.meta.executes && ctx.params.truncate === false,
    message: () => `Full output requested. Large results may flood context.`,
  },
  {
    test: ctx => ctx.resultMeta?.truncated && ctx.resultMeta?.storedAs,
    message: ctx => `Truncated. Full result in $${ctx.resultMeta!.storedAs}`,
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
// Error Tips (ONE source of truth for error help messages)
// ============================================================================

export const errorTips = {
  reload: (path: string, storeAs: string) =>
    `💡 Reload file again: mcx_file({ path: "${path}", storeAs: "${storeAs}" })`,

  loadFirst: (storeAs: string) =>
    `💡 Load first: mcx_file({ path: "/abs/path/file", storeAs: "${storeAs}" })`,

  useExisting: (varName: string) =>
    `💡 Use: mcx_file({ storeAs: "${varName}", code: "..." }) to read the content.`,

  alreadyLoaded: (existingVar: string, correctedCode: string) =>
    `Already loaded as ${existingVar}. Use: mcx_file({ storeAs: "${existingVar}", code: "${correctedCode}" })`,


  validParams: (params: string[]) =>
    `💡 Valid: ${params.join(", ")}`,

  // file.ts
  fullFileFillsContext: () =>
    `💡 Returning full file fills context. Use grep/lines instead.`,

  writeRequiresString: (varName: string) =>
    `💡 ${varName}: write requires code to return string, e.g.: $var.raw.replace('old', 'new')`,

  // search.ts  
  noSpecLoaded: () =>
    `💡 No spec loaded. Use mcx_doctor() to check config.`,

  // grep.ts
  grepNeedsDirectory: (path: string) =>
    `💡 Path must be a DIRECTORY, not a file: "${path}". Use mcx_file with grep() for single files.`,

  noSearchTerm: () =>
    `💡 No search term found. Example: mcx_grep({ query: '*.ts useState' })`,

  missingGrepPath: (searchTerm: string) =>
    `💡 Missing path. Example: mcx_grep({ query: "${searchTerm}", path: "/project/src" })`,

  // fetch.ts
  invalidUrl: (url: string) =>
    `💡 Invalid URL: "${url}". Must start with http:// or https://`,
};

// ============================================================================
// Event Tips (ONE source of truth for event notifications)
// ============================================================================

export const eventTips = {
  autoIndex: (label: string, sizeBytes: number) => {
    const sizeKB = Math.round(sizeBytes / 1024);
    const short = label.includes('/') ? label.split('/').pop() : label.split(':').pop() || label;
    return `📦 Auto-indexed as "${short}" (${sizeKB}KB). Use mcx_search({ queries: [...], source: "${short}" })`;
  },
  
  grepNoMatches: (term: string, filesSearched: number) =>
    `No matches for "${term}" in ${filesSearched} files\n-> Try: broader pattern or different path`,

  linesHunting: (varName: string, count: number) =>
    `Hunting pattern (${count}x). Use grep(${varName}, 'pattern', 5) for context.`,

  linesOverlap: (varName: string) =>
    `💡 Overlapping ranges. Use grep(${varName}, 'pattern', 5) to locate.`,
};
