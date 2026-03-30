/**
 * MCX MCP Server
 *
 * Exposes MCP tools:
 * - mcx_execute: Execute code in sandboxed environment with adapter access
 * - mcx_run_skill: Run a named skill with optional inputs
 * - mcx_list: List available adapters and skills
 * - mcx_search: Search adapters, methods, and indexed content (FTS5)
 * - mcx_batch: Batch executions and searches (bypasses throttling)
 * - mcx_file: Process local files with code ($file)
 * - mcx_fetch: Fetch URL and index content
 * - mcx_stats: Session statistics
 *
 * Features:
 * - Auto-loads adapters from ~/.mcx/adapters/
 * - Generates TypeScript types for LLM context
 * - Network isolation, pre-execution analysis, code normalization
 * - Supports stdio and HTTP transports
 */

import { join, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pc from "picocolors";
import { BunWorkerSandbox, generateTypesSummary } from "@papicandela/mcx-core";

// FFF types - lazy loaded to avoid native binary requirement
type FileFinder = Awaited<ReturnType<typeof import("@ff-labs/fff-bun")>>["FileFinder"] extends { create: (opts: unknown) => { ok: true; value: infer T } } ? T : never;
import { getMcxHomeDir, getAdaptersDir, ensureMcxHomeDir, findProjectRoot } from "../utils/paths";
import { isDangerousEnvKey, isBlockedUrl } from "../utils/security";
import { logger } from "../utils/logger";
import { getContentStore, searchWithFallback, getDistinctiveTerms, batchSearch, htmlToMarkdown, isHtml } from "../search";
import { getSandboxState } from "../sandbox";
import { loadSpecsFromAdapters } from "../spec";

// ============================================================================
// .env Loading
// ============================================================================

/**
 * Load environment variables from a .env file
 * Returns the number of variables loaded
 * SECURITY: Validates key names and blocks dangerous variable overwrites
 */
async function loadEnvFromPath(envPath: string, label: string): Promise<number> {
  const file = Bun.file(envPath);

  if (!(await file.exists())) {
    return 0;
  }

  try {
    const content = await file.text();
    let loaded = 0;
    let skipped = 0;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // SECURITY: Validate key is a safe identifier pattern
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.error(pc.yellow(`Warning: Skipped invalid env key "${key}" in ${label}`));
        skipped++;
        continue;
      }

      // SECURITY: Block dangerous environment variables
      if (isDangerousEnvKey(key)) {
        console.error(pc.yellow(`Warning: Skipped dangerous env key "${key}" in ${label}`));
        skipped++;
        continue;
      }

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
      loaded++;
    }

    if (loaded > 0) {
      console.error(pc.dim(`Loaded ${loaded} env var(s) from ${label}${skipped > 0 ? ` (${skipped} skipped)` : ""}`));
    }
    return loaded;
  } catch (error) {
    console.error(pc.yellow(`Warning: Failed to load ${label}: ${error}`));
    return 0;
  }
}

/**
 * Load environment variables from global MCX home directory
 * e.g., ~/.mcx/.env
 */
async function loadEnvFile(): Promise<void> {
  const mcxHome = getMcxHomeDir();
  const envPath = join(mcxHome, ".env");
  await loadEnvFromPath(envPath, "~/.mcx");
}

// ============================================================================
// Types (CLI-specific, compatible with @papicandela/mcx-core)
// ============================================================================

// Note: These types are intentionally local to serve.ts for CLI-specific needs.
// They are compatible with the unified types in @papicandela/mcx-core.
// Future refactor: import base types from core and extend here.

interface Skill {
  name: string;
  description?: string;
  /** CLI-specific: input schema for skills */
  inputs?: Record<string, { type: string; description?: string; default?: unknown }>;
  run: (ctx: { inputs: Record<string, unknown> }) => Promise<unknown>;
}

/** Compatible with @papicandela/mcx-core AdapterTool */
interface AdapterMethod {
  description: string;
  parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
  execute: (params: unknown) => Promise<unknown>;
}

/** Compatible with @papicandela/mcx-core Adapter */
interface Adapter {
  name: string;
  description?: string;
  /** Domain/category for tool discovery (e.g., 'payments', 'database', 'email') */
  domain?: string;
  tools: Record<string, AdapterMethod>;
  /** Internal: marks adapter as lazy-loaded (not yet fully loaded) */
  __lazy?: boolean;
  /** Internal: path to load full adapter from */
  __path?: string;
}

/** Compatible with @papicandela/mcx-core MCXConfig */
interface MCXConfig {
  adapters?: Adapter[];
  sandbox?: {
    timeout?: number;
    memoryLimit?: number;
  };
  env?: Record<string, string | undefined>;
}

// ============================================================================
// Zod Schemas
// ============================================================================

const ExecuteInputSchema = z.object({
  code: z.string()
    .min(1, "Code cannot be empty")
    .describe("JavaScript/TypeScript code to execute in the sandbox"),
  truncate: z.boolean()
    .optional()
    .default(true)
    .describe("Whether to truncate large results (default: true)"),
  maxItems: z.number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(10)
    .describe("Max array items to return when truncating (default: 10, max: 1000)"),
  maxStringLength: z.number()
    .int()
    .min(10)
    .max(10000)
    .optional()
    .default(500)
    .describe("Max string length when truncating (default: 500, max: 10000)"),
  intent: z.string()
    .optional()
    .describe("Search intent for large outputs (>5KB). Auto-indexes result and returns relevant snippets."),
  storeAs: z.string()
    .optional()
    .describe("Variable name to store result for use in subsequent executions (e.g., 'invoices' → access as $invoices)"),
}).strict();

const RunSkillInputSchema = z.object({
  skill: z.string()
    .min(1, "Skill name is required")
    .describe("The name of the skill to run"),
  inputs: z.record(z.unknown())
    .optional()
    .default({})
    .describe("Input parameters for the skill"),
  truncate: z.boolean()
    .optional()
    .default(true)
    .describe("Whether to truncate large results (default: true)"),
  maxItems: z.number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(10)
    .describe("Max array items to return when truncating (default: 10, max: 1000)"),
  maxStringLength: z.number()
    .int()
    .min(10)
    .max(10000)
    .optional()
    .default(500)
    .describe("Max string length when truncating (default: 500, max: 10000)"),
}).strict();

const ListInputSchema = z.object({
  truncate: z.boolean()
    .optional()
    .default(true)
    .describe("Whether to truncate large results (default: true)"),
  maxItems: z.number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .default(20)
    .describe("Max adapters/skills to return when truncating (default: 20, max: 500)"),
}).strict();

const SearchInputSchema = z.object({
  // Mode 1: Spec exploration (code)
  code: z.string()
    .optional()
    .describe("JS code to explore $spec. Example: Object.keys($spec.adapters) or $spec.adapters.stripe.tools"),
  // Mode 2: FTS5 content search (queries)
  queries: z.array(z.string())
    .optional()
    .describe("FTS5 search queries for indexed content (from mcx_execute with intent)"),
  source: z.string()
    .optional()
    .describe("Filter FTS5 search to specific source label"),
  // Mode 3: Adapter/method search (existing)
  query: z.string()
    .optional()
    .describe("Search term to find adapters, methods, or skills (searches names and descriptions). Optional if adapter is specified."),
  adapter: z.string()
    .optional()
    .describe("Filter to a specific adapter by name (exact or partial match). Use this to list all methods of an adapter."),
  method: z.string()
    .optional()
    .describe("Filter to a specific method by name (exact or partial match). Best used with adapter parameter."),
  type: z.enum(["all", "adapters", "methods", "skills"])
    .optional()
    .default("all")
    .describe("Filter results by type"),
  limit: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Max number of results per category (default: 20, max: 100)"),
  storeAs: z.string()
    .optional()
    .describe("Store result as variable (e.g., 'methods' → access as $methods). Returns summary instead of full result."),
}).strict();

const BatchInputSchema = z.object({
  executions: z.array(z.object({
    code: z.string().describe("Code to execute"),
    storeAs: z.string().optional().describe("Variable name to store result"),
  }))
    .optional()
    .describe("Array of code executions to run sequentially"),
  queries: z.array(z.string())
    .optional()
    .describe("FTS5 search queries to run on indexed content"),
  source: z.string()
    .optional()
    .describe("Filter searches to specific source label"),
}).strict();

type ExecuteInput = z.infer<typeof ExecuteInputSchema>;
type RunSkillInput = z.infer<typeof RunSkillInputSchema>;
type ListInput = z.infer<typeof ListInputSchema>;
type SearchInput = z.infer<typeof SearchInputSchema>;
type BatchInput = z.infer<typeof BatchInputSchema>;

// ============================================================================
// Result Summarization (per Anthropic's code execution article)
// ============================================================================

/** Maximum characters in a single response (MCP best practice) */
const CHARACTER_LIMIT = 25000;
/** Threshold for auto-indexing large outputs when intent is specified */
const INTENT_THRESHOLD = 5000;
/** Threshold for auto-indexing file content in mcx_file (10KB) */
const FILE_INDEX_THRESHOLD = 10_000;
/** Search throttling: normal results up to this many calls */
const THROTTLE_AFTER = 3;
/** Search throttling: block after this many calls */
const BLOCK_AFTER = 8;
/** Search throttling window in ms */
const THROTTLE_WINDOW_MS = 60_000;
/** Max params to show in full (above this, truncate) */
const MAX_PARAMS_FULL = 10;
/** Max params to show when truncating */
const MAX_PARAMS_TRUNCATED = 8;
/** Max description length before truncating */
const MAX_DESC_LENGTH = 80;
/** Max log lines to show */
const MAX_LOGS = 20;

/** Truncate logs array with "... +N more" message */
function truncateLogs(logs: string[]): string[] {
  if (logs.length <= MAX_LOGS) return logs;
  return [...logs.slice(0, MAX_LOGS), `... +${logs.length - MAX_LOGS} more`];
}

// ============================================================================
// Native Image Support
// ============================================================================

/** Marker interface for native MCP images - adapters return this for efficient image handling */
interface McxImageContent {
  __mcx_image__: true;
  mimeType: string;
  data: string; // base64
}

/** Check if a value is an MCX image marker */
function isMcxImage(value: unknown): value is McxImageContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as McxImageContent).__mcx_image__ === true &&
    typeof (value as McxImageContent).mimeType === "string" &&
    typeof (value as McxImageContent).data === "string"
  );
}

/** MCP image content type */
type ImageContent = { type: "image"; mimeType: string; data: string };

/** Extract images from result, returning remaining value and extracted images */
function extractImages(value: unknown): { value: unknown; images: ImageContent[] } {
  // Early return for primitives (most common case)
  if (value === null || typeof value !== "object") {
    return { value, images: [] };
  }

  // Direct image - replace with metadata so agent knows image was captured
  if (isMcxImage(value)) {
    return {
      value: { __image__: true, mimeType: value.mimeType, size: value.data.length },
      images: [{ type: "image", mimeType: value.mimeType, data: value.data }],
    };
  }

  // Array - fast path if no images
  if (Array.isArray(value)) {
    if (!value.some(isMcxImage)) {
      return { value, images: [] };
    }
    const images: ImageContent[] = [];
    const nonImages: unknown[] = [];
    for (const item of value) {
      if (isMcxImage(item)) {
        images.push({ type: "image", mimeType: item.mimeType, data: item.data });
      } else {
        nonImages.push(item);
      }
    }
    return { value: nonImages, images };
  }

  // Object - fast path if no image properties
  const obj = value as Record<string, unknown>;
  let hasImage = false;
  for (const val of Object.values(obj)) {
    if (isMcxImage(val)) { hasImage = true; break; }
  }
  if (!hasImage) {
    return { value, images: [] };
  }

  // Extract images from object properties
  const images: ImageContent[] = [];
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (isMcxImage(val)) {
      images.push({ type: "image", mimeType: val.mimeType, data: val.data });
      // Omit the image property entirely instead of sentinel
    } else {
      result[key] = val;
    }
  }
  return { value: result, images };
}

/**
 * Safe JSON.stringify that handles BigInt and circular references
 */
function safeStringify(value: unknown, indent: number = 2): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    // Handle BigInt
    if (typeof val === "bigint") {
      return val.toString() + "n";
    }
    // Handle circular references
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        return "[Circular]";
      }
      seen.add(val);
    }
    return val;
  }, indent);
}

/**
 * Enforce character limit on text output
 */
function enforceCharacterLimit(text: string, limit: number = CHARACTER_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const truncatedText = text.slice(0, limit) + `\n\n... [Response truncated at ${limit} chars, original was ${text.length} chars. Use more specific queries or lower truncation limits.]`;
  return { text: truncatedText, truncated: true };
}

interface TruncateOptions {
  enabled: boolean;
  maxItems: number;
  maxStringLength: number;
}

/** Format "Stored as $name" message consistently */
function formatStoredAs(name: string | undefined, suffix = ''): string {
  return name ? `Stored as $${name}${suffix}` : '';
}

/** Generate rich metadata about a stored value */
function getValueMetadata(value: unknown): { type: string; count?: number; keys?: string[]; sample?: unknown } {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };

  const type = Array.isArray(value) ? 'array' : typeof value;

  if (Array.isArray(value)) {
    const sample = value.length > 0 ? value[0] : undefined;
    const sampleKeys = sample && typeof sample === 'object' && sample !== null
      ? Object.keys(sample).slice(0, 10)
      : undefined;
    return { type: 'array', count: value.length, keys: sampleKeys, sample: sampleKeys ? undefined : sample };
  }

  if (type === 'object' && value !== null) {
    const keys = Object.keys(value as object).slice(0, 20);
    return { type: 'object', count: keys.length, keys };
  }

  return { type };
}

/** Format metadata as readable string */
function formatMetadata(meta: ReturnType<typeof getValueMetadata>): string {
  if (meta.type === 'array') {
    const keysStr = meta.keys ? ` [${meta.keys.join(', ')}]` : '';
    return `array(${meta.count})${keysStr}`;
  }
  if (meta.type === 'object') {
    return `object{${meta.keys?.join(', ')}}`;
  }
  return meta.type;
}

interface SummarizedResult {
  value: unknown;
  truncated: boolean;
  originalSize?: string;
}

function summarizeResult(value: unknown, opts: TruncateOptions): SummarizedResult {
  if (!opts.enabled) {
    return { value, truncated: false };
  }

  if (value === undefined || value === null) {
    return { value, truncated: false };
  }

  // Create a shared seen set for circular reference detection
  const seen = new WeakSet<object>();

  if (Array.isArray(value)) {
    if (value.length > opts.maxItems) {
      return {
        value: value.slice(0, opts.maxItems).map(v => summarizeObject(v, opts, 0, seen)),
        truncated: true,
        originalSize: `${value.length} items, showing first ${opts.maxItems}`,
      };
    }
    return { value: value.map(v => summarizeObject(v, opts, 0, seen)), truncated: false };
  }

  if (typeof value === "object") {
    return { value: summarizeObject(value, opts, 0, seen), truncated: false };
  }

  if (typeof value === "string" && value.length > opts.maxStringLength) {
    return {
      value: `${value.slice(0, opts.maxStringLength)}... [${value.length} chars]`,
      truncated: true,
      originalSize: `${value.length} chars`,
    };
  }

  return { value, truncated: false };
}

/** Max recursion depth to prevent stack overflow on deeply nested objects */
const MAX_SUMMARIZE_DEPTH = 10;

/** Map MCX parameter types to TypeScript types */
function mapMcxType(type: string | undefined): string {
  if (type === "object") return "Record<string, unknown>";
  if (type === "array") return "unknown[]";
  return type || "unknown";
}

function getExampleValue(paramName: string, paramType: string, schemaExample?: unknown): string {
  // 1. If OpenAPI provides an example, use it
  if (schemaExample !== undefined) {
    return JSON.stringify(schemaExample);
  }

  // 2. Heuristics based on param name
  const nameLower = paramName.toLowerCase();

  // IDs
  if (nameLower === "id" || nameLower.endsWith("_id") || nameLower.endsWith("id")) {
    return "123";
  }

  // Pagination
  if (nameLower === "limit" || nameLower === "count" || nameLower === "size" || nameLower === "pagesize") return "10";
  if (nameLower === "offset" || nameLower === "start" || nameLower === "skip") return "0";
  if (nameLower === "page") return "1";

  // Dates
  if (nameLower.includes("date")) return '"2024-01-15"';

  // Contact info
  if (nameLower === "email") return '"user@example.com"';
  if (nameLower === "name") return '"John Doe"';
  if (nameLower === "phone") return '"+1234567890"';

  // URLs
  if (nameLower === "url" || nameLower.endsWith("url")) return '"https://example.com"';

  // Query/search
  if (nameLower === "query" || nameLower === "q" || nameLower === "search") return '"search term"';

  // 3. Fallback by type
  switch (paramType) {
    case "number":
      return "10";
    case "boolean":
      return "true";
    case "unknown[]":
      return "[]";
    case "Record<string, unknown>":
      return "{}";
    default:
      return '"..."';
  }
}

function summarizeObject(obj: unknown, opts: TruncateOptions, depth: number = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") {
    if (typeof obj === "string" && obj.length > opts.maxStringLength) {
      return `${obj.slice(0, opts.maxStringLength)}... [${obj.length} chars]`;
    }
    return obj;
  }

  // Guard against circular references
  if (seen.has(obj as object)) {
    return "[Circular]";
  }
  seen.add(obj as object);

  // Guard against deep nesting
  if (depth >= MAX_SUMMARIZE_DEPTH) {
    return "[Max depth exceeded]";
  }

  if (Array.isArray(obj)) {
    if (obj.length > opts.maxItems) {
      return [...obj.slice(0, opts.maxItems).map(v => summarizeObject(v, opts, depth + 1, seen)), `... +${obj.length - opts.maxItems} more`];
    }
    return obj.map(v => summarizeObject(v, opts, depth + 1, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(val) && val.length > opts.maxItems) {
      result[key] = [...val.slice(0, opts.maxItems).map(v => summarizeObject(v, opts, depth + 1, seen)), `... +${val.length - opts.maxItems} more`];
    } else if (typeof val === "string" && val.length > opts.maxStringLength) {
      result[key] = `${val.slice(0, opts.maxStringLength)}... [${val.length} chars]`;
    } else if (typeof val === "object" && val !== null) {
      result[key] = summarizeObject(val, opts, depth + 1, seen);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ============================================================================
// Config & Skills Loading (using Bun native APIs)
// ============================================================================

async function loadConfig(): Promise<MCXConfig | null> {
  const configPath = join(process.cwd(), "mcx.config.ts");
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return null;
  }

  try {
    console.error(pc.dim(`Loading config: ${configPath}`));
    const configModule = await import(configPath);
    const config = configModule.default || configModule;
    console.error(pc.dim(`Loaded ${config?.adapters?.length || 0} adapter(s)`));

    // Copy config.env to process.env for adapters that read from process.env
    // SECURITY: Apply same validation as .env files
    if (config?.env) {
      let injected = 0;
      for (const [key, value] of Object.entries(config.env)) {
        if (value === undefined || value === null) continue;

        // SECURITY: Block dangerous environment variables from config.env
        if (isDangerousEnvKey(key)) {
          console.error(pc.yellow(`Warning: Skipped dangerous env key "${key}" in config.env`));
          continue;
        }

        process.env[key] = String(value);
        injected++;
      }
      console.error(pc.dim(`Injected ${injected} env var(s) from config.env`));
    }

    return config;
  } catch (error) {
    console.error(pc.yellow(`Warning: Failed to load mcx.config.ts: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
}

async function loadSkills(): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const skillsDir = join(process.cwd(), "skills");

  if (!existsSync(skillsDir)) {
    return skills;
  }

  // Use Bun.Glob to find skill files
  const glob = new Bun.Glob("**/*.{ts,js}");

  for await (const path of glob.scan({ cwd: skillsDir, onlyFiles: true })) {
    const fullPath = join(skillsDir, path);

    // Skip index files in subdirectories for now, handle them separately
    if (path.includes("/") && !path.endsWith("/index.ts") && !path.endsWith("/index.js")) {
      continue;
    }

    try {
      const skillModule = await import(fullPath);
      const skill = skillModule.default || skillModule;

      if (skill && typeof skill.run === "function") {
        const skillName = skill.name || path.replace(/\/(index)?\.(ts|js)$/, "").replace(/\.(ts|js)$/, "");
        skills.set(skillName, skill);
      }
    } catch (error) {
      console.error(pc.yellow(`Warning: Failed to load skill ${path}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  return skills;
}

/** Convert kebab-case to camelCase: "chrome-devtools" -> "chromeDevtools" */
function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ============================================================================
// Lazy Adapter Loading from ~/.mcx/adapters/
// ============================================================================

/** Cache of fully loaded adapters (loaded on first use) */
const loadedAdapters = new Map<string, Adapter>();

/**
 * Extract adapter metadata without fully loading the module.
 * Reads the file and parses basic info using regex (fast).
 */
async function extractAdapterMetadata(filePath: string): Promise<{ name: string; description?: string; domain?: string; methods: string[] } | null> {
  try {
    const content = await Bun.file(filePath).text();

    // Extract name from defineAdapter({ name: '...' })
    const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/);
    if (!nameMatch) return null;

    const name = nameMatch[1];

    // Extract description
    const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
    const description = descMatch?.[1];

    // Extract domain if present
    const domainMatch = content.match(/domain:\s*['"]([^'"]+)['"]/);
    const domain = domainMatch?.[1];

    // Extract method names from tools: { methodName: { ... } }
    const methods: string[] = [];
    const toolsMatch = content.match(/tools:\s*\{([\s\S]*?)\n\s*\}/);
    if (toolsMatch) {
      // Match method definitions: methodName: { or 'method-name': {
      const methodMatches = toolsMatch[1].matchAll(/^\s+['"]?([a-zA-Z_][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*)['"]?\s*:\s*\{/gm);
      for (const match of methodMatches) {
        methods.push(match[1]);
      }
    }

    return { name, description, domain, methods };
  } catch {
    return null;
  }
}

/**
 * Create a lazy adapter stub that loads the full adapter on first method call.
 */
function createLazyAdapter(metadata: { name: string; description?: string; domain?: string; methods: string[] }, filePath: string): Adapter {
  const lazyTools: Record<string, AdapterMethod> = {};

  for (const methodName of metadata.methods) {
    lazyTools[methodName] = {
      description: `[Lazy] Method from ${metadata.name}`,
      execute: async (params: unknown) => {
        // Load full adapter on first call
        let fullAdapter = loadedAdapters.get(metadata.name);
        if (!fullAdapter) {
          console.error(pc.dim(`Lazy loading adapter: ${metadata.name}`));
          const module = await import(filePath);
          fullAdapter = module.default || module[metadata.name] || Object.values(module).find((v: unknown) => (v as Adapter)?.name === metadata.name);
          if (fullAdapter) {
            loadedAdapters.set(metadata.name, fullAdapter);
          }
        }

        if (!fullAdapter?.tools[methodName]) {
          throw new Error(`Method ${methodName} not found in ${metadata.name}`);
        }

        return fullAdapter.tools[methodName].execute(params);
      },
    };
  }

  return {
    name: metadata.name,
    description: metadata.description,
    domain: metadata.domain,
    tools: lazyTools,
    __lazy: true,
    __path: filePath,
  };
}

/**
 * Load adapters from ~/.mcx/adapters/ with lazy loading.
 * Only extracts metadata at startup; full adapter loaded on first use.
 */
async function loadAdaptersFromDir(): Promise<Adapter[]> {
  const adaptersDir = getAdaptersDir();

  if (!existsSync(adaptersDir)) {
    return [];
  }

  // Collect all paths first
  const glob = new Bun.Glob("*.{ts,js}");
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: adaptersDir, onlyFiles: true })) {
    files.push(join(adaptersDir, file));
  }

  // Parallelize metadata extraction
  const results = await Promise.all(
    files.map(async (fullPath) => {
      try {
        const metadata = await extractAdapterMetadata(fullPath);
        if (metadata && metadata.methods.length > 0) {
          return createLazyAdapter(metadata, fullPath);
        }
      } catch (error) {
        console.error(pc.yellow(`Warning: Failed to scan adapter ${basename(fullPath)}: ${error instanceof Error ? error.message : String(error)}`));
      }
      return null;
    })
  );

  const adapters = results.filter((a): a is Adapter => a !== null);

  if (adapters.length > 0) {
    console.error(pc.dim(`Scanned ${adapters.length} lazy adapter(s) from ~/.mcx/adapters/`));
  }

  return adapters;
}

/**
 * Levenshtein distance for fuzzy parameter name matching
 */
function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Find similar parameter names using fuzzy matching
 */
function findSimilarParams(name: string, validParams: string[], maxDist = 3): string[] {
  const normalized = name.toLowerCase().replace(/[-_]/g, '');
  return validParams
    .map(p => ({ param: p, dist: levenshtein(normalized, p.toLowerCase().replace(/[-_]/g, '')) }))
    .filter(x => x.dist <= maxDist && x.dist > 0)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 2)
    .map(x => x.param);
}

/**
 * Generate a readable signature from parameter definitions
 */
function formatSignature(
  methodName: string,
  params: Record<string, { type: string; description?: string; required?: boolean }> | undefined
): string {
  if (!params || Object.keys(params).length === 0) {
    return `${methodName}()`;
  }
  const paramList = Object.entries(params)
    .map(([name, def]) => {
      const optional = def.required === false ? '?' : '';
      return `${name}${optional}: ${def.type}`;
    })
    .join(', ');
  return `${methodName}({ ${paramList} })`;
}

/**
 * Validate parameters and return helpful error message if invalid
 */
function validateParams(
  adapterName: string,
  methodName: string,
  params: unknown,
  paramDefs: Record<string, { type: string; description?: string; required?: boolean }> | undefined
): { valid: true } | { valid: false; error: string } {
  // No param definitions = no validation
  if (!paramDefs || Object.keys(paramDefs).length === 0) {
    return { valid: true };
  }

  const providedParams = (params && typeof params === 'object' && !Array.isArray(params))
    ? params as Record<string, unknown>
    : {};

  const expectedNames = Object.keys(paramDefs);
  const providedNames = Object.keys(providedParams);
  const errors: string[] = [];
  const hints: string[] = [];

  // Check for missing required params
  for (const [name, def] of Object.entries(paramDefs)) {
    if (def.required !== false && !(name in providedParams)) {
      errors.push(`missing required '${name}'`);
    }
  }

  for (const provided of providedNames) {
    if (!(provided in paramDefs)) {
      const similar = findSimilarParams(provided, expectedNames);
      if (similar.length > 0) {
        hints.push(`'${provided}' → did you mean '${similar[0]}'?`);
      } else {
        errors.push(`unknown param '${provided}'`);
      }
    }
  }

  // Check types for provided params
  for (const [name, value] of Object.entries(providedParams)) {
    const def = paramDefs[name];
    if (!def) continue;

    const actualType = Array.isArray(value) ? 'array' : typeof value;
    const expectedType = def.type.toLowerCase();

    // Basic type checking (string, number, boolean, array, object)
    if (expectedType === 'string' && typeof value !== 'string') {
      errors.push(`'${name}' should be string, got ${actualType}`);
    } else if (expectedType === 'number' && typeof value !== 'number') {
      errors.push(`'${name}' should be number, got ${actualType}`);
    } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
      errors.push(`'${name}' should be boolean, got ${actualType}`);
    } else if (expectedType === 'array' && !Array.isArray(value)) {
      errors.push(`'${name}' should be array, got ${actualType}`);
    }
  }

  if (errors.length === 0 && hints.length === 0) {
    return { valid: true };
  }

  // Build helpful error message
  const signature = formatSignature(methodName, paramDefs);
  const gotParams = providedNames.length > 0
    ? `{ ${providedNames.join(', ')} }`
    : '{}';

  let msg = `Invalid parameters for ${adapterName}.${methodName}()\n`;
  msg += `  Expected: ${signature}\n`;
  msg += `  Received: ${gotParams}`;

  if (errors.length > 0) {
    msg += `\n  Errors: ${errors.join('; ')}`;
  }
  if (hints.length > 0) {
    msg += `\n  Hints: ${hints.join('; ')}`;
  }

  return { valid: false, error: msg };
}

function buildAdapterContext(adapters: Adapter[]): Record<string, Record<string, (params: unknown) => Promise<unknown>>> {
  const ctx: Record<string, Record<string, (params: unknown) => Promise<unknown>>> = {};

  for (const adapter of adapters) {
    const methods: Record<string, (params: unknown) => Promise<unknown>> = {};
    for (const [methodName, method] of Object.entries(adapter.tools)) {
      // Wrap execute with parameter validation
      methods[methodName] = async (params: unknown) => {
        const validation = validateParams(adapter.name, methodName, params, method.parameters);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
        return method.execute((params ?? {}) as Record<string, unknown>);
      };
    }

    // Register under original name
    ctx[adapter.name] = methods;

    // Also register camelCase alias for kebab-case names (chrome-devtools -> chromeDevtools)
    if (adapter.name.includes('-')) {
      ctx[toCamelCase(adapter.name)] = methods;
    }
  }

  return ctx;
}

// ============================================================================
// MCP Server Factory
// ============================================================================

async function createMcxServerWithDeps(
  config: MCXConfig | null,
  adapters: Adapter[],
  skills: Map<string, Skill>
) {
  return createMcxServerCore(config, adapters, skills);
}

async function createMcxServer() {
  // Parallelize independent startup operations
  const [config, lazyAdapters, skills] = await Promise.all([
    loadConfig(),
    loadAdaptersFromDir(),
    loadSkills(),
  ]);

  const configAdapters = config?.adapters || [];

  // Merge adapters: config adapters take precedence over lazy adapters (by name)
  const configNames = new Set(configAdapters.map(a => a.name));
  const filteredLazyAdapters = lazyAdapters.filter(a => !configNames.has(a.name));
  const adapters = [...configAdapters, ...filteredLazyAdapters];

  console.error(pc.dim(`Loaded ${configAdapters.length} config + ${filteredLazyAdapters.length} lazy adapter(s), ${skills.size} skill(s)`));
  return createMcxServerCore(config, adapters, skills);
}

async function createMcxServerCore(
  config: MCXConfig | null,
  adapters: Adapter[],
  skills: Map<string, Skill>
) {
  const sandbox = new BunWorkerSandbox({
    timeout: config?.sandbox?.timeout ?? 30000,
    memoryLimit: config?.sandbox?.memoryLimit ?? 128,
    allowAsync: true,
  });

  const adapterContext = buildAdapterContext(adapters);

  // Build descriptions for tool hints
  const skillNames = Array.from(skills.keys()).join(", ") || "none";
  const skillList = Array.from(skills.entries())
    .map(([name, skill]) => `- ${name}: ${skill.description || "No description"}`)
    .join("\n") || "No skills loaded";

  // Generate concise summary for tool description (full types available via mcx_search)
  const typeSummary = adapters.length > 0
    ? generateTypesSummary(adapters as Parameters<typeof generateTypesSummary>[0])
    : "none";

  // Cache spec for mcx_search Mode 1 (adapters don't change after startup)
  const cachedSpec = loadSpecsFromAdapters(adapters);

  // Search throttling state
  let searchCallCount = 0;
  let searchWindowStart = Date.now();

  function checkAndConsumeThrottle(): { calls: number; blocked: boolean; reducedLimit: boolean } {
    const now = Date.now();
    if (now - searchWindowStart > THROTTLE_WINDOW_MS) {
      searchCallCount = 0;
      searchWindowStart = now;
    }
    searchCallCount++;
    return {
      calls: searchCallCount,
      blocked: searchCallCount > BLOCK_AFTER,
      reducedLimit: searchCallCount > THROTTLE_AFTER,
    };
  }

  // Execution counter (instance-scoped like searchCallCount)
  let executionCounter = 0;

  function generateExecutionLabel(storeAs?: string): string {
    if (storeAs) return storeAs;
    executionCounter++;
    return `exec_${executionCounter}`;
  }

  // Initialize FFF (Fast File Finder) for fuzzy search - optional, graceful fallback
  let fileFinder: FileFinder | null = null;
  try {
    const { FileFinder: FF } = await import("@ff-labs/fff-bun");
    const fffInit = FF.create({
      basePath: process.cwd(),
      frecencyDbPath: join(getMcxHomeDir(), "frecency.db"),
    });
    if (fffInit.ok) {
      fileFinder = fffInit.value;
      console.error(pc.dim(`FFF initialized for: ${process.cwd()}`));
      // Wait for initial scan (non-blocking, 5s timeout)
      fileFinder.waitForScan(5000);
    } else {
      console.error(pc.yellow(`FFF init skipped: ${fffInit.error}`));
    }
  } catch (err) {
    console.error(pc.yellow(`FFF not available (native binary missing) - mcx_find/mcx_grep disabled`));
  }

  const server = new McpServer({
    name: "mcx-mcp-server",
    version: "0.1.0",
  });

  // Tool: mcx_execute
  server.registerTool(
    "mcx_execute",
    {
      title: "Execute Code in MCX Sandbox",
      description: `Execute JavaScript/TypeScript code in an isolated sandbox.

## Calling Adapters
Adapters are available as globals. Use camelCase for names with hyphens:
- supabase.list_projects()
- chromeDevtools.listPages()  // chrome-devtools → chromeDevtools
- adapters['chrome-devtools'].listPages()  // bracket notation also works

## Available Adapters
${typeSummary}

Use mcx_search({ adapter: "name" }) for method details.

## Built-in Helpers
- pick(arr, ['id', 'name']) - Extract fields
- first(arr, 5) - First N items
- count(arr, 'field') - Count by field
- sum(arr, 'field') - Sum numeric field

## Variables
- Results auto-stored as $result
- storeAs: "name" → $name
- $clear: Clear all
- delete $varname: Delete specific variable

## Large Output Handling
- intent: Auto-index output >5KB and search. Returns snippets instead of full data.

Example: { code: "alegra.getInvoices()", storeAs: "invoices", intent: "find overdue" }

IMPORTANT: Always filter/transform data before returning to minimize context.`,
      inputSchema: ExecuteInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: ExecuteInput) => {
      try {
        const state = getSandboxState();
        const code = params.code.trim();

        // Handle special variable commands
        if (code === '$clear') {
          const count = state.keys().length;
          state.clear();
          return {
            content: [{ type: "text" as const, text: `Cleared ${count} variables.` }],
            structuredContent: { cleared: count },
          };
        }

        const deleteMatch = code.match(/^delete\s+\$(\w+)$/);
        if (deleteMatch) {
          const varName = deleteMatch[1];
          const deleted = state.delete(varName);
          return {
            content: [{ type: "text" as const, text: deleted ? `Deleted $${varName}` : `Variable $${varName} not found` }],
            structuredContent: { deleted: deleted ? varName : null },
          };
        }

        // Execute code in sandbox
        const result = await sandbox.execute(code, {
          adapters: adapterContext,
          variables: state.getAllPrefixed(),
          env: config?.env || {},
        });

        if (!result.success) {
          const errorMsg = result.error
            ? `${result.error.name}: ${result.error.message}`
            : "Unknown error";
          const truncatedLogs = truncateLogs(result.logs);
          const logsSection = truncatedLogs.length > 0 ? `\n\nLogs:\n${truncatedLogs.join("\n")}` : "";
          return {
            content: [{ type: "text" as const, text: `Execution error: ${errorMsg}${logsSection}` }],
            isError: true,
          };
        }

        // Extract native images before summarization
        const { value: valueWithoutImages, images } = extractImages(result.value);

        // Auto-store in $result + custom name if specified
        state.set('result', result.value);
        if (params.storeAs && params.storeAs !== 'result') {
          state.set(params.storeAs, result.value);
        }

        // Generate rich metadata about stored value
        const metadata = getValueMetadata(result.value);
        const metaStr = formatMetadata(metadata);

        // Intent auto-index: if output is large and intent specified, index and search
        if (params.intent) {
          const serialized = safeStringify(valueWithoutImages);

          if (serialized.length > INTENT_THRESHOLD) {
            try {
              const store = getContentStore();
              const sourceLabel = generateExecutionLabel(params.storeAs);
              const sourceId = store.index(serialized, sourceLabel, { contentType: 'plaintext' });
              const chunks = store.getChunks(sourceId);
              const searchResults = searchWithFallback(store, params.intent, { limit: 5, sourceId });
              const terms = getDistinctiveTerms(chunks);

              const indexedOutput = [
                `Indexed ${chunks.length} sections as "${sourceLabel}"`,
                formatStoredAs(params.storeAs),
                '',
                `Search results for "${params.intent}":`,
                ...searchResults.map(r => `- ${r.title}: ${r.snippet.slice(0, 200)}...`),
                '',
                `Distinctive terms: ${terms.slice(0, 15).join(', ')}`,
                '',
                'Use mcx_search to query this indexed content.',
              ].filter(Boolean).join('\n');

              return {
                content: [{ type: "text" as const, text: indexedOutput }, ...images],
                structuredContent: {
                  indexed: true,
                  sourceId,
                  chunks: chunks.length,
                  searchResults: searchResults.length,
                  metadata,
                  storedAs: params.storeAs && params.storeAs !== 'result' ? ['result', params.storeAs] : ['result'],
                },
              };
            } catch (indexError) {
              // Indexing failed - fall through to normal summarization
              console.error(`Intent indexing failed: ${indexError instanceof Error ? indexError.message : indexError}`);
            }
          }
        }

        const summarized = summarizeResult(valueWithoutImages, {
          enabled: params.truncate,
          maxItems: params.maxItems,
          maxStringLength: params.maxStringLength,
        });
        const truncatedLogs = truncateLogs(result.logs);

        // Build store message with metadata
        const storedVars = params.storeAs && params.storeAs !== 'result'
          ? `$result, $${params.storeAs}`
          : '$result';
        const storeMsg = `Stored as ${storedVars} (${metaStr})`;

        const rawTextOutput = [
          storeMsg,
          truncatedLogs.length > 0 ? `Logs:\n${truncatedLogs.join("\n")}` : "",
          summarized.truncated
            ? `Result (${summarized.originalSize}):\n${safeStringify(summarized.value)}`
            : valueWithoutImages !== undefined && valueWithoutImages !== null
              ? `Result:\n${safeStringify(summarized.value)}`
              : images.length > 0
                ? "Image(s) attached"
                : "Code executed successfully",
        ].filter(Boolean).join("\n\n");

        // Enforce character limit as safety net
        const { text: textOutput, truncated: charLimitTruncated } = enforceCharacterLimit(rawTextOutput);

        // Build content array with text first, then images
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
          { type: "text" as const, text: textOutput },
          ...images,
        ];

        // Minimal structuredContent - only include non-default values
        const structured: Record<string, unknown> = { result: summarized.value };
        if (summarized.truncated || charLimitTruncated) structured.truncated = true;
        if (params.storeAs && params.storeAs !== 'result') structured.storedAs = params.storeAs;

        return { content, structuredContent: structured };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Sandbox error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_run_skill
  server.registerTool(
    "mcx_run_skill",
    {
      title: "Run MCX Skill",
      description: `Run a registered MCX skill by name.

Available skills: [${skillNames}]
${skillList}`,
      inputSchema: RunSkillInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: RunSkillInput) => {
      const skill = skills.get(params.skill);

      if (!skill) {
        return {
          content: [{ type: "text" as const, text: `Error: Skill '${params.skill}' not found.\n\nAvailable: ${Array.from(skills.keys()).join(", ") || "none"}` }],
          isError: true,
        };
      }

      // Wrap skill execution with timeout to prevent hanging
      const timeoutMs = config?.sandbox?.timeout ?? 30000;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Skill '${params.skill}' timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        const result = await Promise.race([
          skill.run({ inputs: params.inputs, ...adapterContext }),
          timeoutPromise,
        ]);

        // Clear timeout to prevent memory leak
        clearTimeout(timeoutId);

        // Truncate skill result to prevent context bloat
        const summarized = summarizeResult(result, {
          enabled: params.truncate,
          maxItems: params.maxItems,
          maxStringLength: params.maxStringLength,
        });

        // Enforce character limit on skill output too
        const rawText = summarized.value !== undefined ? safeStringify(summarized.value) : "Skill executed successfully";
        const { text: finalText, truncated: charLimitTruncated } = enforceCharacterLimit(rawText);

        return {
          content: [{ type: "text" as const, text: finalText }],
          structuredContent: { result: summarized.value, truncated: summarized.truncated || charLimitTruncated },
        };
      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Skill '${params.skill}' error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_list
  server.registerTool(
    "mcx_list",
    {
      title: "List MCX Adapters and Skills",
      description: "List all available MCX adapters and skills with their methods and descriptions.",
      inputSchema: ListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: ListInput) => {
      // Apply truncation if enabled
      const maxItems = params.truncate ? params.maxItems : Infinity;

      const adaptersList = adapters.slice(0, maxItems).map((a) => ({
        name: a.name,
        description: a.description || "No description",
        methodCount: Object.keys(a.tools).length,
      }));

      const skillsList = Array.from(skills.entries())
        .slice(0, maxItems)
        .map(([name, skill]) => ({
          name,
          description: skill.description || "No description",
        }));

      const output = {
        adapters: adaptersList,
        skills: skillsList,
        truncated: params.truncate && (adapters.length > maxItems || skills.size > maxItems),
        total: { adapters: adapters.length, skills: skills.size },
      };

      // Store in $list
      const state = getSandboxState();
      state.set('list', output);

      // Return compact summary
      const summary = [
        `${output.total.adapters} adapters, ${output.total.skills} skills`,
        `Adapters: ${adaptersList.map(a => `${a.name}(${a.methodCount})`).join(', ')}`,
        output.total.skills > 0 ? `Skills: ${skillsList.map(s => s.name).join(', ')}` : '',
        '',
        'Stored as $list. Use mcx_search(adapter: "name") for details.',
      ].filter(Boolean).join('\n');

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: {
          storedAs: ['list'],
          counts: output.total,
          truncated: output.truncated,
        },
      };
    }
  );

  // Tool: mcx_search
  server.registerTool(
    "mcx_search",
    {
      title: "Search MCX Adapters, Specs, and Indexed Content",
      description: `Three search modes:

## Mode 1: Spec Exploration (code param)
Query $spec with JS. All $refs pre-resolved.
- mcx_search({ code: "Object.keys($spec.adapters)" })
- mcx_search({ code: "$spec.adapters.stripe.tools.createCustomer" })

## Mode 2: Content Search (queries param)
FTS5 search on indexed content (from mcx_execute with intent).
- mcx_search({ queries: ["error", "timeout"] })
- mcx_search({ queries: ["invoice"], source: "exec_1" })

## Mode 3: Adapter/Method Search (query/adapter/method params)
- mcx_search({ adapter: "stripe" }) - List all methods
- mcx_search({ adapter: "stripe", method: "createCustomer" }) - EXACT → detailed params

## Token Saving: storeAs
Use storeAs to save results and return summary only:
- mcx_search({ adapter: "supabase", storeAs: "supaMethods" })
- Then access via $supaMethods in mcx_execute`,
      inputSchema: SearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: SearchInput) => {
      const requestedLimit = params.limit || 20;

      // Mode 1: Spec exploration with code (no throttling - local operation)
      if (params.code) {
        try {
          // Execute code against cached $spec (intentional dynamic eval for spec exploration)
          // eslint-disable-next-line @typescript-eslint/no-implied-eval
          const fn = new Function('$spec', `"use strict"; return (${params.code})`);
          const result = fn(cachedSpec);

          // Store result if requested
          if (params.storeAs) {
            const state = getSandboxState();
            state.set(params.storeAs, result);
            const summary = Array.isArray(result)
              ? `Stored ${result.length} items as $${params.storeAs}`
              : `Stored result as $${params.storeAs}`;
            return {
              content: [{ type: "text" as const, text: summary }],
              structuredContent: { mode: 'spec', storedAs: params.storeAs, itemCount: Array.isArray(result) ? result.length : 1 },
            };
          }

          // Auto-store in $search (no storeAs since early return handles that case)
          const state = getSandboxState();
          state.set('search', result);

          const output = safeStringify(result);
          const { text, truncated } = enforceCharacterLimit(output);

          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { mode: 'spec', storedAs: ['search'], truncated },
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Spec query error: ${error instanceof Error ? error.message : error}` }],
            isError: true,
          };
        }
      }

      // Throttling for Mode 2 and Mode 3 (not Mode 1 which is local)
      const throttle = checkAndConsumeThrottle();
      if (throttle.blocked) {
        return {
          content: [{ type: "text" as const, text: `Search blocked: ${throttle.calls} calls in ${Math.floor(THROTTLE_WINDOW_MS / 1000)}s. Use mcx_batch or wait.` }],
          isError: true,
        };
      }
      const limit = throttle.reducedLimit ? Math.min(1, requestedLimit) : requestedLimit;

      // Mode 2: FTS5 content search
      if (params.queries && params.queries.length > 0) {
        try {
          const store = getContentStore();
          const sources = store.getSources();

          if (sources.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No indexed content. Use mcx_execute with intent to index output." }],
              structuredContent: { mode: 'content', results: 0 },
            };
          }

          // Find source by label if specified
          let sourceId: number | undefined;
          if (params.source) {
            const sourceLabel = params.source;
            const source = sources.find(s => s.label === sourceLabel || s.label.includes(sourceLabel));
            sourceId = source?.id;
          }

          const resultsByQuery = batchSearch(store, params.queries, { limit, sourceId });
          const allResults = Object.values(resultsByQuery).flat();

          // Store in $search
          const state = getSandboxState();
          const searchResult = { queries: params.queries, results: allResults, resultsByQuery };
          state.set('search', searchResult);
          if (params.storeAs && params.storeAs !== 'search') {
            state.set(params.storeAs, searchResult);
          }

          const rawOutput = [
            `Found ${allResults.length} results for: ${params.queries.join(', ')}`,
            params.source ? `Source: ${params.source}` : `Searching ${sources.length} sources`,
            '',
            ...allResults.slice(0, 5).map(r => `## ${r.title} (${r.sourceLabel})\n${r.snippet.slice(0, 200)}...`),
            allResults.length > 5 ? `\n... +${allResults.length - 5} more in $search.results` : '',
          ].join('\n');

          const { text: output, truncated } = enforceCharacterLimit(rawOutput);

          return {
            content: [{ type: "text" as const, text: output }],
            structuredContent: { mode: 'content', storedAs: ['search'], results: allResults.length, truncated },
          };
        } catch (error) {
          return {
            content: [{ type: "text" as const, text: `Content search error: ${error instanceof Error ? error.message : error}` }],
            isError: true,
          };
        }
      }

      // Mode 3: Adapter/method search (existing logic)
      const query = params.query?.toLowerCase();
      const adapterFilter = params.adapter?.toLowerCase();
      const methodFilter = params.method?.toLowerCase();
      const searchType = params.type || "all";

      // Require at least one filter for Mode 3
      if (!query && !adapterFilter && !methodFilter) {
        return {
          content: [{ type: "text" as const, text: "Please provide at least one of: query, adapter, or method parameter" }],
          isError: true,
        };
      }

      const results: {
        adapters: Array<{ name: string; description: string; matchedMethods: string[] }>;
        methods: Array<{
          adapter: string;
          method: string;
          description: string;
          typescript: string;
          parameters?: Record<string, { type: string; description?: string; required: boolean; default?: unknown }>;
          requires?: Record<string, string[]>;
          responseSchema?: Record<string, unknown>;
          example?: string;
        }>;
        skills: Array<{ name: string; description: string }>;
        pagination: { adapters_truncated: number; methods_truncated: number; skills_truncated: number };
      } = {
        adapters: [],
        methods: [],
        skills: [],
        pagination: { adapters_truncated: 0, methods_truncated: 0, skills_truncated: 0 },
      };

      // Search adapters and methods
      if (searchType === "all" || searchType === "adapters" || searchType === "methods") {
        let methodCount = 0;
        let adapterCount = 0;

        for (const adapter of adapters) {
          // Filter by adapter name if specified
          if (adapterFilter) {
            const adapterNameLower = adapter.name.toLowerCase();
            if (!adapterNameLower.includes(adapterFilter) && adapterNameLower !== adapterFilter) {
              continue; // Skip this adapter entirely
            }
          }

          const adapterMatchesQuery = query
            ? (adapter.name.toLowerCase().includes(query) ||
               (adapter.description?.toLowerCase().includes(query) ?? false))
            : true; // If no query, adapter matches if it passed adapter filter

          const matchedMethods: string[] = [];

          for (const [methodName, method] of Object.entries(adapter.tools)) {
            const methodNameLower = methodName.toLowerCase();

            // Filter by method name if specified
            if (methodFilter) {
              if (!methodNameLower.includes(methodFilter) && methodNameLower !== methodFilter) {
                continue; // Skip this method
              }
            }

            const methodMatchesQuery = query
              ? (methodNameLower.includes(query) ||
                 (method.description?.toLowerCase().includes(query) ?? false))
              : true; // If no query, method matches if it passed method filter

            // Include method if it matches query OR if we're filtering by adapter/method without query
            if (methodMatchesQuery || (adapterMatchesQuery && !methodFilter)) {
              matchedMethods.push(methodName);

              if (searchType === "all" || searchType === "methods") {
                // Enforce limit for methods
                if (methodCount >= limit) {
                  results.pagination.methods_truncated++;
                  continue;
                }

                // Check if this is an EXACT method name match (for detailed output)
                const isExactMatch = methodFilter && methodNameLower === methodFilter;

                // Generate TypeScript signature
                const methodParams = method.parameters
                  ? Object.entries(method.parameters)
                      .map(([name, def]) => {
                        const opt = def.required === true ? "" : "?";
                        return `${name}${opt}: ${mapMcxType(def.type)}`;
                      })
                      .join(", ")
                  : "";

                const typescript = methodParams
                  ? `${adapter.name}.${methodName}({ ${methodParams} }): Promise<unknown>`
                  : `${adapter.name}.${methodName}(): Promise<unknown>`;

                // Only include detailed params and example for EXACT matches (saves tokens)
                let detailedParams: Record<string, { type: string; description?: string; required: boolean; default?: unknown; example?: unknown }> | undefined;
                let example: string | undefined;

                if (isExactMatch && method.parameters) {
                  detailedParams = {};
                  for (const [paramName, paramDef] of Object.entries(method.parameters)) {
                    detailedParams[paramName] = {
                      type: mapMcxType(paramDef.type),
                      description: paramDef.description,
                      required: paramDef.required === true,
                      default: (paramDef as { default?: unknown }).default,
                      example: (paramDef as { example?: unknown }).example,
                    };
                  }
                  const requiredParams = Object.entries(detailedParams).filter(([, d]) => d.required);
                  example = requiredParams.length > 0
                    ? `await ${adapter.name}.${methodName}({ ${requiredParams.map(([n, d]) => `${n}: ${getExampleValue(n, d.type, d.example)}`).join(", ")} })`
                    : `await ${adapter.name}.${methodName}()`;
                }

                // Get requires and responseSchema from cached spec (for exact matches)
                let requires: Record<string, string[]> | undefined;
                let responseSchema: Record<string, unknown> | undefined;
                if (isExactMatch) {
                  const toolSpec = cachedSpec.adapters[adapter.name]?.tools[methodName];
                  if (toolSpec?.requires) {
                    requires = toolSpec.requires;
                  }
                  if (toolSpec?.responseSchema) {
                    responseSchema = toolSpec.responseSchema;
                  }
                }

                results.methods.push({
                  adapter: adapter.name,
                  method: methodName,
                  description: method.description || "No description",
                  typescript,
                  parameters: detailedParams,
                  requires,
                  responseSchema,
                  example,
                });
                methodCount++;
              }
            }
          }

          if ((searchType === "all" || searchType === "adapters") && matchedMethods.length > 0) {
            // Enforce limit for adapters
            if (adapterCount >= limit) {
              results.pagination.adapters_truncated++;
            } else {
              // Also limit matched methods shown per adapter
              results.adapters.push({
                name: adapter.name,
                description: adapter.description || "No description",
                matchedMethods: matchedMethods.slice(0, 10),
              });
              adapterCount++;
            }
          }
        }
      }

      // Search skills (only if no adapter/method filter, since those are adapter-specific)
      if ((searchType === "all" || searchType === "skills") && !adapterFilter && !methodFilter) {
        let skillCount = 0;
        for (const [name, skill] of skills.entries()) {
          const matches = query
            ? (name.toLowerCase().includes(query) ||
               (skill.description?.toLowerCase().includes(query) ?? false))
            : true;

          if (matches) {
            if (skillCount >= limit) {
              results.pagination.skills_truncated++;
            } else {
              results.skills.push({
                name,
                description: skill.description || "No description",
              });
              skillCount++;
            }
          }
        }
      }

      // Format output
      const totalMatches = results.adapters.length + results.methods.length + results.skills.length;
      const totalTruncated = results.pagination.adapters_truncated + results.pagination.methods_truncated + results.pagination.skills_truncated;

      // Build filter description for output
      const filters: string[] = [];
      if (params.adapter) filters.push(`adapter="${params.adapter}"`);
      if (params.method) filters.push(`method="${params.method}"`);
      if (params.query) filters.push(`query="${params.query}"`);
      const filterDesc = filters.join(", ");

      if (totalMatches === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for ${filterDesc}` }],
          structuredContent: results,
        };
      }

      const output = [
        totalTruncated > 0
          ? `Found ${totalMatches} result(s) for ${filterDesc} (${totalTruncated} more not shown, use limit param):`
          : `Found ${totalMatches} result(s) for ${filterDesc}:`,
        "",
      ];

      if (results.adapters.length > 0) {
        output.push("## Adapters");
        for (const a of results.adapters) {
          output.push(`- **${a.name}**: ${a.description}`);
          if (a.matchedMethods.length > 0) {
            output.push(`  Methods: ${a.matchedMethods.join(", ")}`);
          }
        }
        output.push("");
      }

      if (results.methods.length > 0) {
        // Show detailed view ONLY for exact method name match (saves tokens on partial searches)
        const isExactMethodMatch = results.methods.length === 1 &&
          methodFilter &&
          results.methods[0].method.toLowerCase() === methodFilter;

        if (isExactMethodMatch) {
          const m = results.methods[0];
          output.push(`## ${m.adapter}.${m.method}`);
          output.push("");
          output.push(m.description);
          output.push("");
          output.push("### Signature");
          output.push("```typescript");
          output.push(m.typescript);
          output.push("```");
          output.push("");

          if (m.parameters && Object.keys(m.parameters).length > 0) {
            const paramEntries = Object.entries(m.parameters);
            const paramCount = paramEntries.length;
            const showAll = paramCount <= MAX_PARAMS_FULL;
            const paramsToShow = showAll ? paramEntries : paramEntries.slice(0, MAX_PARAMS_TRUNCATED);

            output.push(`### Parameters${showAll ? '' : ` (showing ${MAX_PARAMS_TRUNCATED} of ${paramCount}, use $search for full list)`}`);
            output.push("");
            for (const [name, def] of paramsToShow) {
              const req = def.required ? "(required)" : "(optional)";
              const defaultVal = def.default !== undefined ? ` = ${JSON.stringify(def.default)}` : "";
              // Truncate long descriptions
              const desc = def.description && def.description.length > MAX_DESC_LENGTH
                ? def.description.slice(0, MAX_DESC_LENGTH - 3) + '...'
                : def.description;
              output.push(`- **${name}**: \`${def.type}\` ${req}${defaultVal}`);
              if (desc) {
                output.push(`  ${desc}`);
              }
            }
            output.push("");
          }

          output.push("### Example");
          output.push("```typescript");
          output.push(m.example || `await ${m.adapter}.${m.method}()`);
          output.push("```");
        } else {
          // Multiple methods - show compact list
          output.push("## Methods (TypeScript)");
          for (const m of results.methods) {
            output.push(`- \`${m.typescript}\``);
            output.push(`  ${m.description}`);
          }
          output.push("");
        }
      }

      if (results.skills.length > 0) {
        output.push("## Skills");
        for (const s of results.skills) {
          output.push(`- **${s.name}**: ${s.description}`);
        }
      }

      // Always store results in $search (separate from $result to avoid conflicts)
      const state = getSandboxState();
      state.set('search', results);
      if (params.storeAs && params.storeAs !== 'search') {
        state.set(params.storeAs, results);
      }

      // For storeAs: return minimal summary
      if (params.storeAs) {
        const storedVars = params.storeAs !== 'search' ? `$search, $${params.storeAs}` : '$search';
        const summary = `Stored ${results.methods.length} methods, ${results.adapters.length} adapters as ${storedVars}\nExplore: $search.methods[0].parameters`;
        return {
          content: [{ type: "text" as const, text: summary }],
          structuredContent: {
            storedAs: params.storeAs !== 'search' ? ['search', params.storeAs] : ['search'],
            counts: {
              methods: results.methods.length,
              adapters: results.adapters.length,
              skills: results.skills.length,
            },
          },
        };
      }

      // Add footer about $search
      output.push("");
      output.push("---");
      output.push("Full results in `$search`. Explore: `$search.methods[0].requires`");

      // Enforce character limit
      const { text: finalText } = enforceCharacterLimit(output.join("\n"));

      return {
        content: [{ type: "text" as const, text: finalText }],
        structuredContent: {
          storedAs: ['search'],
          counts: {
            methods: results.methods.length,
            adapters: results.adapters.length,
            skills: results.skills.length,
          },
        },
      };
    }
  );

  // Tool: mcx_batch
  server.registerTool(
    "mcx_batch",
    {
      title: "Batch Execute and Search",
      description: `Run multiple executions and searches in one call. Bypasses throttling.

Examples:
- mcx_batch({ executions: [{ code: "alegra.getInvoices()", storeAs: "inv" }], queries: ["overdue"] })
- mcx_batch({ queries: ["error", "timeout", "failed"] })`,
      inputSchema: BatchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: BatchInput) => {
      const output: string[] = [];
      const results: {
        executions: Array<{ storeAs?: string; success: boolean; error?: string }>;
        searches: Array<{ query: string; count: number }>;
      } = { executions: [], searches: [] };

      // Run executions sequentially
      if (params.executions && params.executions.length > 0) {
        output.push("## Executions");
        output.push("");

        // Hoist singletons outside loop
        const state = getSandboxState();
        const store = getContentStore();

        for (const exec of params.executions) {
          try {
            // Get stored variables fresh each iteration (state mutates via storeAs)
            const result = await sandbox.execute(exec.code, {
              adapters: adapterContext,
              variables: state.getAllPrefixed(),
              env: config?.env || {},
            });

            if (result.success) {
              // Store if requested
              if (exec.storeAs) {
                state.set(exec.storeAs, result.value);
              }

              // Auto-index large results
              const serialized = safeStringify(result.value);
              if (serialized.length > INTENT_THRESHOLD) {
                try {
                  const sourceLabel = generateExecutionLabel(exec.storeAs);
                  store.index(serialized, sourceLabel, { contentType: 'plaintext' });
                  output.push(`- ${exec.storeAs || 'exec'}: Indexed (${serialized.length} chars)`);
                } catch {
                  // Indexing failed, still report success
                  output.push(`- ${exec.storeAs || 'exec'}: OK (${serialized.length} chars, index failed)`);
                }
              } else {
                output.push(`- ${exec.storeAs || 'exec'}: OK (${serialized.length} chars)`);
              }

              results.executions.push({ storeAs: exec.storeAs, success: true });
            } else {
              const errorMsg = result.error ? result.error.message : "Unknown error";
              output.push(`- ${exec.storeAs || 'exec'}: ERROR - ${errorMsg}`);
              results.executions.push({ storeAs: exec.storeAs, success: false, error: errorMsg });
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            output.push(`- ${exec.storeAs || 'exec'}: ERROR - ${errorMsg}`);
            results.executions.push({ storeAs: exec.storeAs, success: false, error: errorMsg });
          }
        }
        output.push("");
      }

      // Run searches (bypass throttling) - use batchSearch for efficiency
      if (params.queries && params.queries.length > 0) {
        output.push("## Search Results");
        output.push("");

        const store = getContentStore();
        const sources = store.getSources();

        if (sources.length === 0) {
          output.push("No indexed content available.");
        } else {
          let sourceId: number | undefined;
          if (params.source) {
            const sourceLabel = params.source;
            const source = sources.find(s => s.label === sourceLabel || s.label.includes(sourceLabel));
            sourceId = source?.id;
          }

          try {
            const batchResults = batchSearch(store, params.queries, { limit: 5, sourceId });
            for (const [query, searchResults] of Object.entries(batchResults)) {
              output.push(`### "${query}" (${searchResults.length} results)`);
              for (const r of searchResults) {
                output.push(`- ${r.title}: ${r.snippet.slice(0, 150)}...`);
              }
              output.push("");
              results.searches.push({ query, count: searchResults.length });
            }
          } catch (error) {
            output.push(`Search error: ${error instanceof Error ? error.message : error}`);
            for (const query of params.queries) {
              results.searches.push({ query, count: 0 });
            }
          }
        }
      }

      // Store in $batch
      const state = getSandboxState();
      state.set('batch', results);

      // Compact summary
      const execCount = results.executions.length;
      const searchCount = results.searches.length;
      const summary = [
        `Batch complete: ${execCount} executions, ${searchCount} searches`,
        `Stored as $batch. Access: $batch.executions, $batch.searches`,
      ].join('\n');

      return {
        content: [{ type: "text" as const, text: summary }],
        structuredContent: {
          storedAs: ['batch'],
          counts: { executions: execCount, searches: searchCount },
        },
      };
    }
  );

  // Tool: mcx_file
  const FileInputSchema = z.object({
    path: z.string().describe("File path to process"),
    code: z.string().describe("JavaScript code to process $file"),
    intent: z.string().optional().describe("Auto-index if output > 5KB"),
    storeAs: z.string().optional().describe("Store result as variable"),
  });
  type FileInput = z.infer<typeof FileInputSchema>;

  server.registerTool(
    "mcx_file",
    {
      title: "Process File",
      description: `Process file with code. File content available as $file.

Examples:
- mcx_file({ path: "data.json", code: "$file.items.length" })
- mcx_file({ path: "config.yaml", code: "$file.lines.filter(l => l.includes('port'))" })
- mcx_file({ path: "report.csv", code: "$file.lines.slice(0, 10)" })

$file shape:
- JSON files: parsed object
- Other files: { text: string, lines: string[] }`,
      inputSchema: FileInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: FileInput) => {
      try {
        const content = await readFile(params.path, 'utf-8');
        const ext = extname(params.path).toLowerCase();

        // Parse based on extension
        let $file: unknown;
        if (ext === '.json') {
          try {
            $file = JSON.parse(content);
          } catch {
            $file = { text: content, lines: content.split('\n') };
          }
        } else {
          $file = { text: content, lines: content.split('\n') };
        }

        // Auto-index file content for later search (sync, like context-mode)
        if (content.length > FILE_INDEX_THRESHOLD) {
          const store = getContentStore();
          const fileLabel = basename(params.path);
          const indexContent = isHtml(content) ? htmlToMarkdown(content) : content;
          store.index(indexContent, fileLabel, { contentType: ext === '.md' ? 'markdown' : 'plaintext' });
        }

        // Execute with $file injected via variables (MCX pattern)
        const state = getSandboxState();
        const result = await sandbox.execute(params.code, {
          adapters: adapterContext,
          variables: { ...state.getAllPrefixed(), $file },
          env: config?.env || {},
        });

        if (!result.success) {
          return {
            content: [{ type: "text" as const, text: `Error: ${result.error?.message || 'Execution failed'}` }],
            isError: true,
          };
        }

        const serialized = safeStringify(result.value);

        // Store if requested
        if (params.storeAs) {
          state.set(params.storeAs, result.value);
        }

        // Intent auto-index for large outputs (aligned with mcx_execute pattern)
        if (params.intent && serialized.length > INTENT_THRESHOLD) {
          try {
            const store = getContentStore();
            const sourceLabel = generateExecutionLabel(params.storeAs || basename(params.path));
            const sourceId = store.index(serialized, sourceLabel, { contentType: 'plaintext' });
            const chunks = store.getChunks(sourceId);
            const searchResults = searchWithFallback(store, params.intent, { limit: 5, sourceId });
            const terms = getDistinctiveTerms(chunks);

            const output = [
              `Indexed ${chunks.length} sections as "${sourceLabel}"`,
              formatStoredAs(params.storeAs),
              '',
              `Search results for "${params.intent}":`,
              ...searchResults.map(r => `- ${r.title}: ${r.snippet.slice(0, 200)}...`),
              '',
              `Distinctive terms: ${terms.slice(0, 15).join(', ')}`,
              '',
              'Use mcx_search to query this indexed content.',
            ].filter(Boolean).join('\n');

            return { content: [{ type: "text" as const, text: output }] };
          } catch {
            // Indexing failed, fall through to normal output
          }
        }

        const { text: finalText, truncated } = enforceCharacterLimit(serialized);
        const storedMsg = params.storeAs ? `\n${formatStoredAs(params.storeAs)}` : '';

        return {
          content: [{ type: "text" as const, text: finalText + storedMsg }],
          structuredContent: {
            result: result.value,
            truncated,
            storeAs: params.storeAs,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Error reading file: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_fetch
  const FetchInputSchema = z.object({
    url: z.string().describe("URL to fetch"),
    queries: z.array(z.string()).optional().describe("Search after indexing"),
  });
  type FetchInput = z.infer<typeof FetchInputSchema>;

  server.registerTool(
    "mcx_fetch",
    {
      title: "Fetch and Index URL",
      description: `Fetch URL and index content. Returns summary + distinctive terms.

Use for: API docs, OpenAPI specs, external documentation.
Examples:
- mcx_fetch({ url: "https://api.example.com/openapi.json" })
- mcx_fetch({ url: "https://docs.example.com/guide", queries: ["auth", "api key"] })`,
      inputSchema: FetchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FetchInput) => {
      try {
        // SECURITY: Block SSRF attacks to internal/private addresses
        const ssrfCheck = isBlockedUrl(params.url);
        if (ssrfCheck.blocked) {
          return {
            content: [{ type: "text" as const, text: `SSRF blocked: ${ssrfCheck.reason}` }],
            isError: true,
          };
        }

        const response = await fetch(params.url);
        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `Fetch failed: ${response.status} ${response.statusText}` }],
            isError: true,
          };
        }

        const contentType = response.headers.get('content-type') || '';
        let content: string;
        let label: string;

        try {
          label = new URL(params.url).hostname;
        } catch {
          label = 'fetched';
        }

        if (contentType.includes('json')) {
          const json = await response.json() as Record<string, unknown>;
          content = JSON.stringify(json, null, 2);
          // Try to extract title from OpenAPI or common JSON structures
          const info = json.info as Record<string, unknown> | undefined;
          if (info?.title && typeof info.title === 'string') label = info.title;
          else if (json.title && typeof json.title === 'string') label = json.title;
          else if (json.name && typeof json.name === 'string') label = json.name;
        } else {
          content = await response.text();
          // For HTML, extract title before conversion
          const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
          if (titleMatch) label = titleMatch[1].trim();
          // Convert HTML to markdown for cleaner indexing
          if (isHtml(content)) {
            content = htmlToMarkdown(content);
          }
        }

        // Index in FTS5
        const store = getContentStore();
        const sourceId = store.index(content, label, { contentType: 'plaintext' });
        const chunks = store.getChunkCount(sourceId);
        const terms = getDistinctiveTerms(store.getChunks(sourceId));

        const output: string[] = [
          `Indexed "${label}": ${chunks} sections, ${content.length} chars`,
          `Terms: ${terms.slice(0, 20).join(', ')}`,
        ];

        // Optional immediate search
        if (params.queries?.length) {
          output.push('');
          output.push('Search Results:');
          const batchResults = batchSearch(store, params.queries, { limit: 3, sourceId });
          for (const [query, results] of Object.entries(batchResults)) {
            output.push(`  "${query}": ${results.length} matches`);
            for (const r of results.slice(0, 2)) {
              output.push(`    - ${r.snippet.slice(0, 100)}...`);
            }
          }
        }

        return { content: [{ type: "text" as const, text: output.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `Fetch error: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_stats
  server.registerTool(
    "mcx_stats",
    {
      title: "Session Statistics",
      description: "Session statistics: indexed content, searches, executions, variables.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const store = getContentStore();
      const sources = store.getSources();
      const totalChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0);
      const state = getSandboxState();
      const variables = Array.from(state.keys());

      let throttleStatus: string;
      if (searchCallCount <= THROTTLE_AFTER) {
        throttleStatus = 'normal';
      } else if (searchCallCount <= BLOCK_AFTER) {
        throttleStatus = 'reduced';
      } else {
        throttleStatus = 'blocked';
      }

      const output = [
        'Session Stats',
        '─────────────',
        `Indexed: ${sources.length} sources, ${totalChunks} chunks`,
        `Searches: ${searchCallCount} calls (${throttleStatus})`,
        `Executions: ${executionCounter}`,
        `Variables: ${variables.length > 0 ? variables.map(v => '$' + v).join(', ') : 'none'}`,
      ];

      if (sources.length > 0) {
        output.push('');
        output.push('Sources:');
        for (const s of sources.slice(0, 10)) {
          output.push(`  ${s.label}: ${s.chunkCount} chunks`);
        }
        if (sources.length > 10) {
          output.push(`  ... and ${sources.length - 10} more`);
        }
      }

      return { content: [{ type: "text" as const, text: output.join('\n') }] };
    }
  );

  // Tool: mcx_find (FFF fuzzy file search)
  const FindInputSchema = z.object({
    query: z.string().describe("Fuzzy search query. Supports: *.ext, !exclude, /path/, status:modified"),
    limit: z.number().optional().default(20).describe("Max results (default: 20)"),
  });
  type FindInput = z.infer<typeof FindInputSchema>;

  server.registerTool(
    "mcx_find",
    {
      title: "Fuzzy File Search",
      description: `Fast fuzzy file search with frecency ranking.

Query syntax:
- "main.ts" - Fuzzy match filename
- "*.ts" - Extension filter
- "!test" - Exclude pattern
- "src/" - Path contains
- "status:modified" - Git modified files

Results ranked by: match score + frecency (recent files boosted) + git status.`,
      inputSchema: FindInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: FindInput) => {
      if (!fileFinder) {
        return {
          content: [{ type: "text" as const, text: "FFF not initialized. Run from a project directory." }],
          isError: true,
        };
      }

      const result = fileFinder.fileSearch(params.query, { pageSize: params.limit });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${result.error}` }],
          isError: true,
        };
      }

      const { items, totalMatched } = result.value;
      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: "No files found." }] };
      }

      const output = [
        `Found ${totalMatched} files (showing ${items.length}):`,
        "",
        ...items.map((f) => {
          const status = f.gitStatus !== "clean" ? ` [${f.gitStatus}]` : "";
          return `${f.relativePath}${status}`;
        }),
      ];

      return { content: [{ type: "text" as const, text: output.join("\n") }] };
    }
  );

  // Tool: mcx_grep (FFF content search)
  const GrepInputSchema = z.object({
    query: z.string().describe("Search pattern. Prefix with *.ext or path/ to filter files."),
    mode: z.enum(["plain", "regex", "fuzzy"]).optional().default("plain").describe("Search mode"),
    limit: z.number().optional().default(50).describe("Max matches (default: 50)"),
  });
  type GrepInput = z.infer<typeof GrepInputSchema>;

  server.registerTool(
    "mcx_grep",
    {
      title: "Content Search",
      description: `SIMD-accelerated content search across files.

Query examples:
- "TODO" - Plain text search
- "*.ts useState" - Search in TypeScript files
- "src/ handleClick" - Search in src directory

Modes:
- plain: Literal text match (fast)
- regex: Regular expression
- fuzzy: Typo-tolerant fuzzy match`,
      inputSchema: GrepInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GrepInput) => {
      if (!fileFinder) {
        return {
          content: [{ type: "text" as const, text: "FFF not initialized. Run from a project directory." }],
          isError: true,
        };
      }

      const result = fileFinder.grep(params.query, {
        mode: params.mode,
        pageLimit: params.limit,
      });
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Grep failed: ${result.error}` }],
          isError: true,
        };
      }

      const { items, totalMatched, totalFilesSearched } = result.value;
      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches in ${totalFilesSearched} files.` }] };
      }

      const output = [
        `${totalMatched} matches in ${totalFilesSearched} files (showing ${items.length}):`,
        "",
      ];

      // Group by file
      const byFile = new Map<string, typeof items>();
      for (const item of items) {
        const existing = byFile.get(item.relativePath) || [];
        existing.push(item);
        byFile.set(item.relativePath, existing);
      }

      for (const [file, matches] of byFile) {
        output.push(`${file}:`);
        for (const m of matches.slice(0, 5)) {
          const line = m.lineContent.trim().slice(0, 100);
          output.push(`  ${m.lineNumber}: ${line}`);
        }
        if (matches.length > 5) {
          output.push(`  ... +${matches.length - 5} more matches`);
        }
      }

      return { content: [{ type: "text" as const, text: output.join("\n") }] };
    }
  );

  return {
    server,
    cleanup: () => fileFinder?.destroy(),
  };
}

// ============================================================================
// Transports
// ============================================================================

async function runStdio() {
  console.error(pc.dim(`[MCX] cwd: ${process.cwd()}`));

  // Load global ~/.mcx/.env
  await loadEnvFile();

  console.error(pc.cyan("Starting MCX MCP server (stdio)...\n"));

  const { server, cleanup } = await createMcxServer();
  const transport = new StdioServerTransport();

  // Handle transport errors to prevent crashes
  transport.onerror = (error) => {
    console.error(pc.red("[MCX] Transport error:"), error);
    logger.error("Transport error", error);
  };

  // Handle stdin close gracefully (e.g., when Claude closes the connection)
  process.stdin.on("close", () => {
    cleanup();
    console.error(pc.dim("[MCX] stdin closed, exiting gracefully"));
    logger.shutdown("stdin closed");
    process.exit(0);
  });

  process.stdin.on("error", (error) => {
    console.error(pc.red("[MCX] stdin error:"), error);
    logger.error("stdin error", error);
    // Don't crash - wait for stdin close
  });

  await server.connect(transport);

  // Log startup
  const pkg = await import("../../package.json");
  logger.startup(pkg.version, "stdio");

  console.error(pc.green("MCX MCP server running"));
  console.error(pc.dim("Tools: mcx_execute, mcx_search, mcx_batch, mcx_file, mcx_fetch, mcx_find, mcx_grep, mcx_stats, mcx_list, mcx_run_skill"));
  console.error(pc.dim(`Logs: ${logger.getLogPath()}`));
}

async function runHttp(port: number) {
  console.error(pc.dim(`[MCX] cwd: ${process.cwd()}`));

  // Load global ~/.mcx/.env
  await loadEnvFile();

  console.error(pc.cyan(`Starting MCX MCP server (HTTP:${port})...\n`));

  const config = await loadConfig();
  const skills = await loadSkills();
  const adapters = config?.adapters || [];
  console.error(pc.dim(`Loaded ${adapters.length} adapter(s), ${skills.size} skill(s)`));

  // PERFORMANCE: Create server and transport ONCE, reuse for all requests
  // This prevents resource exhaustion from creating new instances per request
  const { server, cleanup } = await createMcxServerWithDeps(config, adapters, skills);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // Cleanup on shutdown
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  console.error(pc.dim("MCP server and transport initialized"));

  // Log startup
  const pkg = await import("../../package.json");
  logger.startup(pkg.version, `http:${port}`);

  Bun.serve({
    port,
    hostname: "127.0.0.1",

    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok", server: "mcx-mcp-server", version: "0.1.0" });
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        try {
          const body = await req.json();

          // SECURITY: Maximum response body size (defense-in-depth)
          // Tool handlers already enforce CHARACTER_LIMIT, but this prevents
          // unbounded memory growth in edge cases
          const MAX_RESPONSE_BODY = 100000; // 100KB

          // Per-request response mock (stateless JSON response mode)
          const mockRes = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            body: "",
            setHeader(name: string, value: string) { this.headers[name] = value; },
            writeHead(status: number, headers?: Record<string, string>) {
              this.statusCode = status;
              if (headers) {
                Object.assign(this.headers, headers);
              }
            },
            end(data?: string) {
              if (data && this.body.length < MAX_RESPONSE_BODY) {
                this.body += data.slice(0, MAX_RESPONSE_BODY - this.body.length);
              }
            },
            write(data: string) {
              if (this.body.length < MAX_RESPONSE_BODY) {
                this.body += data.slice(0, MAX_RESPONSE_BODY - this.body.length);
              }
            },
            on() {},
          };

          await transport.handleRequest(req as never, mockRes as never, body);

          // If MCP SDK set error status but no body, return a helpful message
          if (mockRes.statusCode >= 400 && !mockRes.body) {
            return Response.json(
              { error: `MCP transport returned status ${mockRes.statusCode}`, jsonrpc: "2.0", id: body?.id },
              { status: mockRes.statusCode, headers: mockRes.headers }
            );
          }

          return new Response(mockRes.body, {
            status: mockRes.statusCode,
            headers: mockRes.headers,
          });
        } catch (error) {
          console.error("MCP request error:", error);
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.error(pc.green(`MCX MCP server running on http://127.0.0.1:${port}/mcp`));
  console.error(pc.dim("Health: GET /health"));
}

// ============================================================================
// Export
// ============================================================================

export interface ServeOptions {
  transport?: "stdio" | "http";
  port?: number;
  cwd?: string;
}

export async function serveCommand(options: ServeOptions = {}): Promise<void> {
  // If cwd is explicitly provided, use it (backward compatible)
  if (options.cwd) {
    // Check if it's a project-local config
    const projectRoot = findProjectRoot(options.cwd);
    if (projectRoot) {
      process.chdir(projectRoot);
      console.error(pc.dim(`[MCX] Using project: ${projectRoot}`));
    } else {
      process.chdir(options.cwd);
      console.error(pc.dim(`[MCX] Using cwd: ${options.cwd}`));
    }
  } else {
    // Default: use global ~/.mcx/ directory
    const mcxHome = ensureMcxHomeDir();
    console.error(pc.dim(`[MCX] Using global: ${mcxHome}`));
    process.chdir(mcxHome);
  }

  if (options.transport === "http") {
    await runHttp(options.port || 3100);
  } else {
    await runStdio();
  }
}
