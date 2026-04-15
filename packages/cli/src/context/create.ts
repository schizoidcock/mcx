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
  import { getMcxHomeDir } from "../utils/paths.js";
  import { join } from "node:path";

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
  }

  // ============================================================================
  // File Helpers Code
  // ============================================================================

  export const FILE_HELPERS_CODE = `
  const isNumbered = (lines) => lines.length > 0 && /^\\d+:\\s/.test(lines[0]);
  const around = (stored, line, ctx = 10) => {
    const start = Math.max(0, line - ctx - 1);
    const end = Math.min(stored.lines.length, line + ctx);
    return stored.lines.slice(start, end).join('\\n');
  };
  const lines = (stored, start, end) => {
    if (!stored?.lines) return 'Error: not a file variable';
    const s = Math.max(0, start - 1);
    const e = Math.min(stored.lines.length, end);
    return stored.lines.slice(s, e).join('\\n');
  };
  const grep = (stored, pattern, ctx = 0) => {
    if (!stored?.lines) return 'Error: not a file variable';
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    const matches = [];
    stored.lines.forEach((line, idx) => {
      if (!regex.test(line)) return;
      const start = Math.max(0, idx - ctx);
      const end = Math.min(stored.lines.length, idx + ctx + 1);
      matches.push(...stored.lines.slice(start, end));
      if (ctx > 0) matches.push('---');
    });
    return matches.length > 0 ? matches.join('\\n') : 'No matches';
  };
  const block = (stored, startLine, endPattern = /^\\s*\\}/) => {
    if (!stored?.lines) return 'Error: not a file variable';
    const start = startLine - 1;
    if (start < 0 || start >= stored.lines.length) return 'Invalid start line';
    const result = [stored.lines[start]];
    for (let i = start + 1; i < stored.lines.length; i++) {
      result.push(stored.lines[i]);
      if (endPattern.test(stored.lines[i].replace(/^\\d+:\\s*/, ''))) break;
    }
    return result.join('\\n');
  };
  const outline = (stored, opts = {}) => {
    if (!stored?.lines) return 'Error: not a file variable';
    const patterns = [
      /^\\d+:\\s*(export\\s+)?(async\\s+)?function\\s+\\w+/,
      /^\\d+:\\s*(export\\s+)?(const|let|var)\\s+\\w+\\s*=/,
      /^\\d+:\\s*(export\\s+)?class\\s+\\w+/,
      /^\\d+:\\s*(export\\s+)?interface\\s+\\w+/,
      /^\\d+:\\s*(export\\s+)?type\\s+\\w+/,
    ];
    return stored.lines.filter(line => patterns.some(p => p.test(line))).slice(0, opts.limit || 50).join('\\n');
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
    if (!obj || typeof obj !== 'object' || depth <= 0) return typeof obj === 'string' ? '"..."' : String(obj);
    const spaces = '  '.repeat(indent);
    if (Array.isArray(obj)) return '[' + obj.length + ' items]';
    const entries = Object.entries(obj).slice(0, 10);
    const lines = entries.map(([k, v]) => spaces + '  ' + k + ': ' + tree(v, depth - 1, indent + 1));
    if (Object.keys(obj).length > 10) lines.push(spaces + '  ... +' + (Object.keys(obj).length - 10) + ' more');
    return '{\\n' + lines.join(',\\n') + '\\n' + spaces + '}';
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
      variables: { stored: new Map(), lastResult: undefined },
      workflow: { lastTools: [], proximityContext: { recentFiles: [], recentPatterns: [] } },
      watchedProjects: new Map(),
      basePath: config.basePath,
      fileHelpersCode: FILE_HELPERS_CODE,
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

  export async function getFinderForPath(ctx: ToolContext, searchPath: string): Promise<FileFinder> {
    const normalizedSearch = searchPath.replace(/\\/g, "/");
    const normalizedBase = ctx.basePath.replace(/\\/g, "/");

    if (normalizedSearch === normalizedBase) return initializeFinder(ctx);

    const cached = ctx.watchedProjects.get(normalizedSearch);
    if (cached) return cached;

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