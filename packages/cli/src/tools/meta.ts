/**
 * Tool Metadata - Single Source of Truth
 */

import { z } from "zod";

// ============================================================================
// Core Types
// ============================================================================

export interface ParamMeta {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: string[];
}

export interface ToolMeta {
  name: string;
  // Capabilities (annotations derived from these)
  reads: boolean;      // Reads files/data
  writes: boolean;     // Writes/modifies files
  executes: boolean;   // Executes code/commands
  network: boolean;    // Accesses network
  // Parameters
  params: ParamMeta[];
}

// ============================================================================
// Tool Metadata Registry
// ============================================================================

export const TOOL_META: ToolMeta[] = [
  // Read-only tools
  {
    name: 'mcx_file',
    reads: true, writes: false, executes: false, network: false,
    params: [
      { name: 'path', type: 'string', description: 'File path to process', required: true },
      { name: 'code', type: 'string', description: 'Code to process file' },
      { name: 'language', type: 'string', description: 'Execution language', enum: ['js', 'shell', 'python'] },
      { name: 'storeAs', type: 'string', description: 'Store result as variable' },
      { name: 'intent', type: 'string', description: 'Auto-index if output > 5KB' },
    ],
  },
  {
    name: 'mcx_grep',
    reads: true, writes: false, executes: false, network: false,
    params: [
      { name: 'query', type: 'string', description: 'Search query with optional file pattern prefix' },
      { name: 'pattern', type: 'string', description: 'Alias for query' },
      { name: 'path', type: 'string', description: 'Directory to search in' },
      { name: 'context', type: 'number', description: 'Lines of context', default: 0, min: 0, max: 50 },
    ],
  },
  {
    name: 'mcx_find',
    reads: true, writes: false, executes: false, network: false,
    params: [
      { name: 'query', type: 'string', description: 'File name or pattern to search for' },
      { name: 'pattern', type: 'string', description: 'Alias for query' },
      { name: 'path', type: 'string', description: 'Directory to search in' },
      { name: 'related', type: 'string', description: 'Find files related to this file' },
      { name: 'limit', type: 'number', description: 'Maximum results', default: 20, min: 1, max: 100 },
    ],
  },
  {
    name: 'mcx_search',
    reads: true, writes: false, executes: false, network: false,
    params: [
      { name: 'query', type: 'string', description: 'Search query', required: true },
      { name: 'source', type: 'string', description: 'Filter by source label' },
      { name: 'limit', type: 'number', description: 'Maximum results', default: 10, min: 1, max: 100 },
    ],
  },
  {
    name: 'mcx_stats',
    reads: true, writes: false, executes: false, network: false,
    params: [],
  },
  {
    name: 'mcx_doctor',
    reads: true, writes: false, executes: false, network: false,
    params: [],
  },
  {
    name: 'mcx_watch',
    reads: true, writes: false, executes: false, network: false,
    params: [
      { name: 'paths', type: 'array', description: 'Paths to watch' },
      { name: 'patterns', type: 'array', description: 'Glob patterns to match' },
      { name: 'debounceMs', type: 'number', description: 'Debounce delay', default: 300, min: 100, max: 10000 },
    ],
  },

  // Write tools
  {
    name: 'mcx_edit',
    reads: false, writes: true, executes: false, network: false,
    params: [
      { name: 'file_path', type: 'string', description: 'Absolute path to the file to edit' },
      { name: 'path', type: 'string', description: 'Alias for file_path' },
      { name: 'start', type: 'number', description: 'Line mode: start line (1-indexed)', min: 1 },
      { name: 'end', type: 'number', description: 'Line mode: end line (1-indexed)', min: 1 },
      { name: 'old_string', type: 'string', description: 'String mode: exact string to replace' },
      { name: 'new_string', type: 'string', description: 'The replacement string' },
      { name: 'code', type: 'string', description: 'JS code for transform mode' },
      { name: 'mode', type: 'string', description: 'Edit mode', enum: ['line', 'string', 'transform'] },
      { name: 'replace_all', type: 'boolean', description: 'Replace all occurrences', default: false },
    ],
  },
  {
    name: 'mcx_write',
    reads: false, writes: true, executes: false, network: false,
    params: [
      { name: 'file_path', type: 'string', description: 'Absolute path to the file' },
      { name: 'path', type: 'string', description: 'Alias for file_path' },
      { name: 'content', type: 'string', description: 'Content to write', required: true },
    ],
  },

  // Execute tools
  {
    name: 'mcx_execute',
    reads: false, writes: false, executes: true, network: true,
    params: [
      { name: 'code', type: 'string', description: 'JS/TS code to execute' },
      { name: 'shell', type: 'string', description: 'Shell command to run' },
      { name: 'python', type: 'string', description: 'Python code to execute' },
      { name: 'storeAs', type: 'string', description: 'Store result as variable' },
      { name: 'intent', type: 'string', description: 'Auto-index large output' },
      { name: 'timeout', type: 'number', description: 'Timeout in ms', default: 30000, min: 0, max: 300000 },
      { name: 'truncate', type: 'boolean', description: 'Truncate output', default: true },
      { name: 'maxItems', type: 'number', description: 'Max array items', default: 10, min: 1, max: 1000 },
      { name: 'maxStringLength', type: 'number', description: 'Max string length', default: 500, min: 1, max: 10000 },
    ],
  },
  {
    name: 'mcx_adapter',
    reads: false, writes: false, executes: true, network: true,
    params: [
      { name: 'name', type: 'string', description: 'Adapter name', required: true },
      { name: 'method', type: 'string', description: 'Method to call', required: true },
      { name: 'params', type: 'object', description: 'Method parameters' },
      { name: 'truncate', type: 'boolean', description: 'Truncate output', default: true },
      { name: 'maxItems', type: 'number', description: 'Max array items', default: 10, min: 1, max: 1000 },
      { name: 'maxStringLength', type: 'number', description: 'Max string length', default: 500, min: 1, max: 10000 },
    ],
  },
  {
    name: 'mcx_tasks',
    reads: false, writes: false, executes: true, network: true,
    params: [
      { name: 'commands', type: 'array', description: 'Shell commands to run' },
      { name: 'operations', type: 'array', description: 'Operations to execute' },
      { name: 'queries', type: 'array', description: 'FTS5 search queries' },
      { name: 'source', type: 'string', description: 'Filter by source' },
      { name: 'timeout', type: 'number', description: 'Timeout in ms', default: 30000, min: 0, max: 300000 },
    ],
  },

  // Network tools
  {
    name: 'mcx_fetch',
    reads: false, writes: false, executes: false, network: true,
    params: [
      { name: 'url', type: 'string', description: 'URL to fetch', required: true },
      { name: 'method', type: 'string', description: 'HTTP method', default: 'GET', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      { name: 'headers', type: 'object', description: 'HTTP headers' },
      { name: 'body', type: 'string', description: 'Request body' },
      { name: 'timeout', type: 'number', description: 'Timeout in ms', default: 30000, min: 0, max: 60000 },
    ],
  },
  {
    name: 'mcx_upgrade',
    reads: false, writes: false, executes: true, network: true,
    params: [],
  },
];

// O(1) lookup by name
export const META_BY_NAME = new Map(TOOL_META.map(m => [m.name, m]));

// ============================================================================
// Derive Annotations (no special cases)
// ============================================================================

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Derive MCP annotations from capabilities
 * Same logic for ALL tools - no switch/case
 */
export function deriveAnnotations(meta: ToolMeta): ToolAnnotations {
  return {
    readOnlyHint: meta.reads && !meta.writes && !meta.executes,
    destructiveHint: meta.writes || meta.executes,
    idempotentHint: meta.reads && !meta.writes && !meta.executes,
    openWorldHint: meta.network,
  };
}

// ============================================================================
// Derive Schema (no special cases)
// ============================================================================

// Coercion helpers (exported for register.ts)
export const booleanLike = z.preprocess(
  v => v === "true" ? true : v === "false" ? false : v,
  z.boolean()
);

const jsonArray = z.preprocess(
  v => {
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return v; }
    }
    return v;
  },
  z.array(z.any())
);

/**
 * Derive Zod schema from ParamMeta
 * One loop, all tools
 */
export function deriveSchema(params: ParamMeta[]): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  
  for (const p of params) {
    let field = buildField(p);
    if (p.description) field = field.describe(p.description);
    if (!p.required) field = field.optional();
    if (p.default !== undefined) field = field.default(p.default);
    shape[p.name] = field;
  }
  
  return z.object(shape);
}

function buildField(p: ParamMeta): z.ZodTypeAny {
  switch (p.type) {
    case 'number':
      return applyLimits(z.coerce.number(), p);
    case 'boolean':
      return booleanLike;
    case 'array':
      return jsonArray;
    case 'object':
      return z.record(z.any());
    default:
      return p.enum ? z.enum(p.enum as [string, ...string[]]) : z.string();
  }
}

function applyLimits(schema: z.ZodNumber, p: ParamMeta): z.ZodNumber {
  if (p.min !== undefined) schema = schema.min(p.min);
  if (p.max !== undefined) schema = schema.max(p.max);
  return schema;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get tool metadata by name
 */
export function getToolMeta(name: string): ToolMeta | undefined {
  return META_BY_NAME.get(name);
}

/**
 * Get all tool names
 */
export function getToolNames(): string[] {
  return TOOL_META.map(m => m.name);
}

/**
 * Check if tool has capability
 */
export function hasCapability(name: string, cap: 'reads' | 'writes' | 'executes' | 'network'): boolean {
  const meta = META_BY_NAME.get(name);
  return meta ? meta[cap] : false;
}
