  /**
   * Tool Context Creation
   *
   * Factory for creating the shared ToolContext.
   * Initializes all components needed by MCP tools.
   */

  import type { FileFinder } from "../utils/fff.js";
  import { BunWorkerSandbox } from "@papicandela/mcx-core";
  import type { ToolContext, AdapterSpec } from "../tools/types.js";
  import { getContentStore, cleanupStaleContent } from "./store.js";
import { getState as getVariablesState } from "./variables.js";
  import { getMcxHomeDir } from "../utils/paths.js";
  import { join } from "node:path";
  import { MAX_WATCHED_PROJECTS } from "../tools/constants.js";
import { createDebugger } from "../utils/debug.js";

const debug = createDebugger("context");

  // ============================================================================
  // Configuration
  // ============================================================================

  export interface ToolContextConfig {
    basePath: string;
    spec?: AdapterSpec;
    sandbox?: {
      timeout?: number;
      maxOutputSize?: number;
      pool?: { enabled?: boolean; maxWorkers?: number; idleTimeout?: number };
    };
    cleanupOnStart?: boolean;
    adapterContext?: Record<string, Record<string, (params: unknown) => Promise<unknown>>>;
  }

  // ============================================================================
  // File Helpers Code
  // ============================================================================

  export const FILE_HELPERS_CODE = `
  // ============================================================================
  // Global constants for FILE_HELPERS_CODE
  // NL, TAB = actual characters (use in split/join)
  // ESC_N, ESC_T = literal escape sequences (for code with backslash-n)
  // ============================================================================
  const NL = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);
  const ESC_N = String.fromCharCode(92) + 'n';  // Literal backslash-n for code
  const ESC_T = String.fromCharCode(92) + 't';  // Literal backslash-t for code
  const isNumbered = (lines) => lines.length > 0 && /^\\d+:\\s/.test(lines[0]);
  const around = (stored, line, ctx = 10) => {
    const start = Math.max(0, line - ctx - 1);
    const end = Math.min(stored.lines.length, line + ctx);
    return stored.lines.slice(start, end).join(NL);
  };
  const lines = (stored, start, end) => {
    if (!stored?.lines) throw new Error('not a file variable');
    const s = Math.max(0, start - 1);
    const e = Math.min(stored.lines.length, end);
    return stored.lines.slice(s, e).join(NL);
  };
  const grep = (stored, pattern, ctx = 0) => {
    if (!stored?.lines) throw new Error('not a file variable');
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    const matches = [];
    stored.lines.forEach((line, idx) => {
      if (!regex.test(line)) return;
      const start = Math.max(0, idx - ctx);
      const end = Math.min(stored.lines.length, idx + ctx + 1);
      matches.push(...stored.lines.slice(start, end));
      if (ctx > 0) matches.push('---');
    });
    return matches.length > 0 ? matches.join(NL) : 'No matches';
  };
  const countBraces = (s) => (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
  const block = (stored, pattern) => {
    if (!stored?.lines) throw new Error('not a file variable');
    const start = stored.lines.findIndex(l => l.includes(pattern));
    if (start < 0) return 'Pattern not found: ' + pattern;
    let depth = 0, entered = false;
    for (let i = start; i < stored.lines.length; i++) {
      depth += countBraces(stored.lines[i].replace(/^\\d+:\\s*/, ''));
      if (depth > 0) entered = true;
      if (entered && depth <= 0) return stored.lines.slice(start, i + 1).join(NL);
    }
    return stored.lines.slice(start).join(NL);
  };
  const OUTLINE_PATTERNS = [
    /^\\d+:\\s*(export\\s+)?(async\\s+)?function\\s+\\w+/,
    /^\\d+:\\s*(export\\s+)?(const|let|var)\\s+\\w+\\s*=/,
    /^\\d+:\\s*(export\\s+)?class\\s+\\w+/,
    /^\\d+:\\s*(export\\s+)?interface\\s+\\w+/,
    /^\\d+:\\s*(export\\s+)?type\\s+\\w+/,
  ];
  const outline = (stored, opts = {}) => {
    if (!stored?.lines) throw new Error('not a file variable');
    const matches = stored.lines.filter(l => OUTLINE_PATTERNS.some(p => p.test(l)));
    return matches.slice(0, opts.limit || 50).join(NL);
  };
  const keys = (obj) => obj ? Object.keys(obj) : [];
  const values = (obj) => obj ? Object.values(obj) : [];
  const paths = (obj, prefix = '') => {
    if (!obj || typeof obj !== 'object') return [];
    const result = [];
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? prefix + '.' + k : k;
      result.push(path);
      if (v && typeof v === 'object' && !Array.isArray(v)) result.push(...paths(v, path));
    }
    return result;
  };
  const tree = (obj, depth = 2, indent = 0) => {
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj !== 'object') return typeof obj === 'string' ? '"..."' : String(obj);
    if (depth <= 0) return Array.isArray(obj) ? '[...]' : '{...}';
    if (Array.isArray(obj)) return '[' + obj.length + ' items]';
    const spaces = '  '.repeat(indent);
    const entries = Object.entries(obj).slice(0, 10);
    const extra = Object.keys(obj).length - 10;
    const lines = entries.map(([k, v]) => spaces + '  ' + k + ': ' + tree(v, depth - 1, indent + 1));
    if (extra > 0) lines.push(spaces + '  ... +' + extra + ' more');
    return '{' + NL + lines.join(',' + NL) + NL + spaces + '}';
  };
  // splice: edit lines with integrity check
  const splice = (stored, startLine, deleteCount, ...newContent) => {
    if (!stored?.lines) throw new Error("not a file variable");
    const rawLines = stored.raw.split(NL);
    const start = Math.max(0, Math.min(startLine - 1, rawLines.length));
    const delCount = Math.max(0, Math.min(deleteCount, rawLines.length - start));
    const toInsert = newContent.flatMap(arg => String(arg).split(NL));
    const expected = rawLines.length - delCount + toInsert.length;
    rawLines.splice(start, delCount, ...toInsert);
    if (rawLines.length !== expected) throw new Error('splice: expected ' + expected + ', got ' + rawLines.length);
    return rawLines.join(NL);
  };
  // spliceInfo: preview splice operation
  const spliceInfo = (stored, startLine, deleteCount, ...newContent) => {
    if (!stored?.lines) throw new Error("not a file variable");
    const rawLines = stored.raw.split(NL);
    const start = Math.max(0, Math.min(startLine - 1, rawLines.length));
    const delCount = Math.max(0, Math.min(deleteCount, rawLines.length - start));
    const toInsert = newContent.flatMap(arg => String(arg).split(NL));
    const deleted = rawLines.slice(start, start + delCount);
    const expanded = toInsert.length !== newContent.length ? ' (from ' + newContent.length + ' args)' : '';
    return [
      'SPLICE: ' + rawLines.length + ' -> ' + (rawLines.length - delCount + toInsert.length) + ' lines',
      'DELETE ' + delCount + ': ' + deleted.slice(0, 3).map(l => l.slice(0, 40)).join(' | ') + (deleted.length > 3 ? '...' : ''),
      'INSERT ' + toInsert.length + expanded + ': ' + toInsert.slice(0, 3).map(l => l.slice(0, 40)).join(' | ') + (toInsert.length > 3 ? '...' : '')
    ].join(NL);
  };
  
  `;

  // Line count for filtering helper logs
  export const FILE_HELPERS_LINE_COUNT = FILE_HELPERS_CODE.split('\n').length;

  // ============================================================================
  // FFF Module Cache
  // ============================================================================

  let FileFinderClass: typeof import("@ff-labs/fff-bun").FileFinder | null = null;

  async function loadFileFinderClass() {
    if (FileFinderClass) return FileFinderClass;
    const { FileFinder } = await import("@ff-labs/fff-bun");
    FileFinderClass = FileFinder;
    return FileFinder;
  }

  // ============================================================================
  // Context Creation
  // ============================================================================

  export async function createToolContext(config: ToolContextConfig): Promise<ToolContext> {
    if (config.cleanupOnStart !== false) {
      try {
        const cleaned = cleanupStaleContent();
        if (cleaned > 0) console.error(`Cleaned up ${cleaned} stale source(s)`);
      } catch { /* ignore */ }
    }

    const sandbox = new BunWorkerSandbox({
      timeout: config.sandbox?.timeout ?? 30000,
      maxOutputSize: config.sandbox?.maxOutputSize ?? 100 * 1024,
      pool: config.sandbox?.pool ?? { enabled: true, maxWorkers: 4, idleTimeout: 30000 },
    });

    return {
      contentStore: getContentStore(),
      sandbox,
      finder: null,
      spec: config.spec ?? null,
      variables: getVariablesState(),
      workflow: { lastTools: [], proximityContext: { recentFiles: [], recentPatterns: [] } },
      watchedProjects: new Map(),
      basePath: config.basePath,
      fileHelpersCode: FILE_HELPERS_CODE,
      adapterContext: config.adapterContext || {},
    };
  }

  export async function initializeFinder(ctx: ToolContext): Promise<FileFinder> {
    if (ctx.finder) return ctx.finder;

    const FileFinder = await loadFileFinderClass();
    const init = FileFinder.create({
      basePath: ctx.basePath,
      frecencyDbPath: join(getMcxHomeDir(), "frecency.db"),
    });

    if (!init.ok) throw new Error(`FFF init failed: ${init.error}`);

    ctx.finder = init.value;
    init.value.waitForScan(5000);
    return ctx.finder;
  }

  /** Evict oldest watched project if at limit (FIFO - Map keeps insertion order) */
  function evictOldestProject(ctx: ToolContext): void {
    if (ctx.watchedProjects.size < MAX_WATCHED_PROJECTS) return;
    
    const oldest = ctx.watchedProjects.keys().next().value;
    const finder = ctx.watchedProjects.get(oldest);
    if ((finder as any)?.destroy) (finder as any).destroy();
    ctx.watchedProjects.delete(oldest);
  }

  export async function getFinderForPath(ctx: ToolContext, searchPath: string): Promise<FileFinder> {
    const normalizedSearch = searchPath.replace(/\\/g, "/");
    const normalizedBase = ctx.basePath.replace(/\\/g, "/");

    if (normalizedSearch === normalizedBase) return initializeFinder(ctx);

    const cached = ctx.watchedProjects.get(normalizedSearch);
    if (cached) return cached;

    evictOldestProject(ctx);

    const FileFinder = await loadFileFinderClass();
    const init = FileFinder.create({ basePath: searchPath });
    if (!init.ok) throw new Error(`FFF init failed for ${searchPath}: ${init.error}`);

    init.value.waitForScan(3000);
    ctx.watchedProjects.set(normalizedSearch, init.value);
    return init.value;
  }

  export async function disposeContext(ctx: ToolContext): Promise<void> {
    if (ctx.sandbox && typeof (ctx.sandbox as any).dispose === "function") (ctx.sandbox as any).dispose();
    if (ctx.finder && typeof (ctx.finder as any).destroy === "function") (ctx.finder as any).destroy();
    for (const finder of ctx.watchedProjects.values()) {
      if (typeof (finder as any).destroy === "function") (finder as any).destroy();
    }
    ctx.watchedProjects.clear();
    ctx.variables.stored.clear();
  }