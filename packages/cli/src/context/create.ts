/**
 * Tool Context Creation
 * 
 * Factory for creating the shared ToolContext.
 * Initializes all components needed by MCP tools.
 */

import type { FileFinder } from "@ff-labs/fff-bun";
import { BunWorkerSandbox } from "@papicandela/mcx-core";
import type { ToolContext, AdapterSpec } from "../tools/types.js";
import { getContentStore, cleanupStaleContent } from "./store.js";

// ============================================================================
// Configuration
// ============================================================================

export interface ToolContextConfig {
  /** Base path for file finder */
  basePath: string;
  
  /** Adapter spec for search */
  spec?: AdapterSpec;
  
  /** Sandbox configuration */
  sandbox?: {
    timeout?: number;
    maxOutputSize?: number;
    pool?: {
      enabled?: boolean;
      maxWorkers?: number;
      idleTimeout?: number;
    };
  };
  
  /** Cleanup stale content on startup */
  cleanupOnStart?: boolean;
}

// ============================================================================
// File Helpers Code
// ============================================================================

const FILE_HELPERS_CODE = `
const isNumbered = (lines) => lines.length > 0 && /^\\d+:\\s/.test(lines[0]);
const around = (stored, line, ctx = 10) => {
  const start = Math.max(0, line - ctx - 1);
  const end = Math.min(stored.lines.length, line + ctx);
  const slice = stored.lines.slice(start, end);
  return slice.join('\\n');
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
    if (regex.test(line)) {
      if (ctx > 0) {
        const start = Math.max(0, idx - ctx);
        const end = Math.min(stored.lines.length, idx + ctx + 1);
        matches.push(...stored.lines.slice(start, end));
        matches.push('---');
      } else {
        matches.push(line);
      }
    }
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
  const matches = stored.lines.filter(line => 
    patterns.some(p => p.test(line))
  );
  return matches.slice(0, opts.limit || 50).join('\\n');
};
// JSON helpers
const keys = (obj) => obj ? Object.keys(obj) : [];
const values = (obj) => obj ? Object.values(obj) : [];
const paths = (obj, prefix = '') => {
  if (!obj || typeof obj !== 'object') return [];
  const result = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? prefix + '.' + k : k;
    result.push(path);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      result.push(...paths(v, path));
    }
  }
  return result;
};
const tree = (obj, depth = 2, indent = 0) => {
  if (!obj || typeof obj !== 'object' || depth <= 0) {
    return typeof obj === 'string' ? '"..."' : String(obj);
  }
  const spaces = '  '.repeat(indent);
  if (Array.isArray(obj)) {
    return '[' + obj.length + ' items]';
  }
  const entries = Object.entries(obj).slice(0, 10);
  const lines = entries.map(([k, v]) => 
    spaces + '  ' + k + ': ' + tree(v, depth - 1, indent + 1)
  );
  if (Object.keys(obj).length > 10) {
    lines.push(spaces + '  ... +' + (Object.keys(obj).length - 10) + ' more');
  }
  return '{\\n' + lines.join(',\\n') + '\\n' + spaces + '}';
};
`;

// ============================================================================
// Context Creation
// ============================================================================

/**
 * Create a new ToolContext with all dependencies initialized.
 */
export async function createToolContext(config: ToolContextConfig): Promise<ToolContext> {
  // Cleanup stale content on startup
  if (config.cleanupOnStart !== false) {
    try {
      const cleaned = cleanupStaleContent();
      if (cleaned > 0) {
        console.error(`Cleaned up ${cleaned} stale source(s)`);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
  
  // Create sandbox
  const sandbox = new BunWorkerSandbox({
    timeout: config.sandbox?.timeout ?? 30000,
    maxOutputSize: config.sandbox?.maxOutputSize ?? 100 * 1024,
    pool: config.sandbox?.pool ?? {
      enabled: true,
      maxWorkers: 4,
      idleTimeout: 30000,
    },
  });
  
  return {
    contentStore: getContentStore(),
    sandbox,
    finder: null,  // Lazy initialized
    spec: config.spec ?? null,
    variables: {
      stored: new Map(),
      lastResult: undefined,
    },
    workflow: {
      lastTools: [],
      proximityContext: {
        recentFiles: [],
        recentPatterns: [],
      },
    },
    watchedProjects: new Map(),
    basePath: config.basePath,
    fileHelpersCode: FILE_HELPERS_CODE,
  };
}

/**
 * Initialize the FileFinder lazily.
 * Called on first use to avoid startup cost.
 */
export async function initializeFinder(ctx: ToolContext): Promise<FileFinder> {
  if (ctx.finder) return ctx.finder;
  
  const { FileFinder } = await import("@ff-labs/fff-bun");
  ctx.finder = new FileFinder(ctx.basePath);
  
  return ctx.finder;
}

/**
 * Get or create a FileFinder for a specific path.
 * Used for multi-project support.
 */
export async function getFinderForPath(
  ctx: ToolContext, 
  searchPath: string
): Promise<FileFinder> {
  // Check if it's the base path
  const normalizedSearch = searchPath;
  const normalizedBase = ctx.basePath;
  
  if (normalizedSearch === normalizedBase) {
    return initializeFinder(ctx);
  }
  
  // Check cached watchers
  const cached = ctx.watchedProjects.get(normalizedSearch);
  if (cached) return cached;
  
  // Create new finder
  const { FileFinder } = await import("@ff-labs/fff-bun");
  const finder = new FileFinder(searchPath);
  ctx.watchedProjects.set(normalizedSearch, finder);
  
  return finder;
}

/**
 * Dispose of a ToolContext and cleanup resources.
 */
export async function disposeContext(ctx: ToolContext): Promise<void> {
  // Dispose sandbox
  if (ctx.sandbox && typeof (ctx.sandbox as any).dispose === "function") {
    (ctx.sandbox as any).dispose();
  }
  
  // Clear watchers
  ctx.watchedProjects.clear();
  
  // Clear variables
  ctx.variables.stored.clear();
}
