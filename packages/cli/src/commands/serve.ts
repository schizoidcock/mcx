/**
 * MCX MCP Server
 *
 * Exposes MCP tools:
 * - mcx_execute: Execute code in sandboxed environment with adapter access
 * - mcx_adapter: Unified adapter/skill discovery and execution
 * - mcx_search: Search adapters, methods, and indexed content (FTS5)
 * - mcx_tasks: Background tasks and batch operations
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

import * as path from "node:path";
import { join, basename, extname, isAbsolute, resolve } from "node:path";

// IMPORT_REGEX and RESOLVE_EXTENSIONS imported from tools/constants.js
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { applyHybridFilter } from "../filters/index.js";
import { registerExtractedTools } from "../tools/register.js";
import type { ToolContext } from "../tools/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pc from "picocolors";
import { BunWorkerSandbox, generateTypesSummary } from "@papicandela/mcx-core";

import { getMcxHomeDir, getAdaptersDir, ensureMcxHomeDir, findProjectRoot, compactPath } from "../utils/paths";
import { startDaemon, stopDaemon } from "../daemon";
import { type FileFinder, isExcludedPath } from "../utils/fff";
import { coerceJsonArray } from "../utils/zod";
import { isDangerousEnvKey, isBlockedUrl, detectShellEscape, enforceShellRedirects, enforcePythonRedirects, blockedResponse } from "../utils/security";
import { analyzeCodeTraits, analyzeShellTraits, formatTraitWarnings } from "../utils/traits";
import { logger } from "../utils/logger";
import { extractImages, type McxImageContent } from "../utils/images";
import { 
  CHARACTER_LIMIT, 
  MAX_LOGS, 
  GREP_MAX_LINE_WIDTH, 
  GREP_MAX_PER_FILE,
  INTENT_THRESHOLD,
  FULL_FILE_WARNING_BYTES,
  FULL_FILE_CODE,
  FILE_INDEX_THRESHOLD,
  AUTO_INDEX_THRESHOLD,
  IMPORT_REGEX,
  RESOLVE_EXTENSIONS,
  MAP_TTL_MS,
  MAP_MAX_ENTRIES,
  MAX_PARAMS_FULL,
  MAX_PARAMS_TRUNCATED,
  MAX_DESC_LENGTH,
  MAX_BACKGROUND_TASKS,
  MAX_RESPONSE_BODY,
} from "../tools/constants.js";
import { truncateLogs, summarizeResult, enforceCharacterLimit, sanitizeForJson, formatFileResult } from "../utils/truncate.js";
import { getContentStore, searchWithFallback, getDistinctiveTerms, batchSearch, htmlToMarkdown, isHtml } from "../search";
import { getSandboxState } from "../sandbox";
import { createToolContext, FILE_HELPERS_CODE } from "../context/create.js";
import { loadSpecsFromAdapters } from "../spec";
import { mcxStats } from "../tools/stats.js";
import { mcxTasks } from "../tools/tasks.js";
import { mcxWatch } from "../tools/watch.js";
import { safeStringify } from "../tools/utils.js";
import { cleanLine } from "../utils/truncate.js";
import { cleanupGuards } from "../context/guards.js";
import { getFileStoreTime } from "../tools/edit.js";
import { getFileEditTime } from "../tools/write.js";
import { formatGrepMCX, type GrepMatch, type FormatGrepOptions } from "../tools/format-grep.js";
import { mcxDoctor } from "../tools/doctor.js";
import { mcxUpgrade } from "../tools/upgrade.js";
import { mcxFind } from "../tools/find.js";
import { mcxGrep } from "../tools/grep.js";
import { mcxEdit } from "../tools/edit.js";
import { mcxWrite } from "../tools/write.js";
import { mcxFetch } from "../tools/fetch.js";
import { mcxFile } from "../tools/file.js";
import { mcxSearch } from "../tools/search.js";
import { createExecuteTool } from "../tools/execute.js";
import { createAdapterTool } from "../tools/adapter.js";


// ============================================================================
// Global Error Handlers (P0 - Critical for debugging crashes)
// ============================================================================

process.on('uncaughtException', (error) => {
  logger.uncaughtException(error);
  console.error(pc.red('[MCX] Uncaught exception:'), error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.unhandledRejection(reason);
  console.error(pc.red('[MCX] Unhandled rejection:'), reason);
});

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
// Result Summarization (per Anthropic's code execution article)
// ============================================================================

// Constants imported from tools/constants.js
/** Cross-platform shell path */
const SHELL_PATH = process.platform === 'win32' 
  ? 'C:\\Program Files\\Git\\bin\\sh.exe' 
  : '/bin/sh';

// killTree removed - now in utils/process.ts

/** Dangerous env vars to filter from shell execution */
const DENIED_ENV = new Set([
  // Shell — auto-execute scripts
  "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "BASH_FUNC_",
  // Node.js — require injection
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  // Python — startup injection
  "PYTHONSTARTUP", "PYTHONHOME", "PYTHONBREAKPOINT", "PYTHONPATH",
  // Dynamic linker — .so injection
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  // Git — hook/config injection
  "GIT_TEMPLATE_DIR", "GIT_SSH", "GIT_ASKPASS", "GIT_CONFIG_GLOBAL",
  // Editor/pager — command execution
  "EDITOR", "VISUAL", "PAGER", "LESS", "LESSOPEN", "LESSCLOSE",
  // Perl/Ruby — library injection
  "PERL5LIB", "PERL5OPT", "RUBYOPT", "RUBYLIB",
  // SSH — agent hijacking
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  // Curl/wget — config injection
  "CURL_HOME", "WGETRC",
  // AWS/Cloud — credential exposure
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET",
  // Generic secrets
  "DATABASE_URL", "REDIS_URL", "API_KEY", "SECRET_KEY", "PRIVATE_KEY",
]);
/** Cached safe environment (computed once at startup) */
let cachedSafeEnv: Record<string, string> | null = null;

/** Get safe environment for shell execution (filters dangerous vars, cached) */
function getSafeEnv(): Record<string, string> {
  if (cachedSafeEnv) return cachedSafeEnv;
  
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !DENIED_ENV.has(key) && !key.includes('SECRET') && !key.includes('PASSWORD') && !key.includes('TOKEN') && !key.includes('CREDENTIAL')) {
      safeEnv[key] = value;
    }
  }
  cachedSafeEnv = safeEnv;
  return safeEnv;
}
// Throttling constants imported from tools/constants.js

/** File access tracking for progressive tips (Optimization #2+#3) */
const fileAccessLog = new Map<string, { count: number; firstAccess: number }>();




/** Grep call tracking for progressive tips (Optimization #9) */
const grepCallLog = { count: 0, firstCall: 0 };

/** Cleanup stale Map entries (called periodically) */
function cleanupStaleMaps(): void {
  const now = Date.now();
  
  // Clean fileAccessLog (entries older than TTL)
  for (const [key, val] of fileAccessLog) {
    if (now - val.firstAccess > MAP_TTL_MS) fileAccessLog.delete(key);
  }
  

  
  // Cleanup guards state (executeFailures, linesCallTracker)
  cleanupGuards(now);
  
  // Cap sizes if still too large (LRU-ish: delete oldest)
  if (fileAccessLog.size > MAP_MAX_ENTRIES) {
    const entries = [...fileAccessLog.entries()].sort((a, b) => a[1].firstAccess - b[1].firstAccess);
    for (let i = 0; i < entries.length - MAP_MAX_ENTRIES; i++) {
      fileAccessLog.delete(entries[i][0]);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleMaps, 5 * 60 * 1000);



/** Create a blocked/error MCP response */
const blockedResponse = (msg: string) => ({ 
  content: [{ type: "text" as const, text: msg }], 
  isError: true as const 
});

// sanitizeForJson imported from utils/truncate

/** Workflow tracking for inefficiency detection (Optimization #5) */
const sessionWorkflow = {
  lastTools: [] as Array<{ tool: string; file?: string; timestamp: number }>,
  maxHistory: 10,
};







// MAX_PARAMS_*, MAX_DESC_LENGTH imported from tools/constants.js






/**
 * Check brace balance in code content


/**
 * Find duplicate lines within new content being added.
 * Only checks for internal duplicates (e.g., two return statements)
 * to catch careless edits. Does NOT compare against surrounding context.
 */
function findDuplicatesInNewString(newString: string): string[] {
  const lines = newString.split('\n');
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, comments, braces, common chained methods, array pushes
    if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed.startsWith('//') ||
        trimmed === '.optional()' || trimmed.startsWith('.describe(') || 
        trimmed === '.default(true)' || trimmed === '.default(false)' ||
        /^\w+\.push\(['"`]/.test(trimmed)) continue;
    // Skip JSX patterns: opening tags, props, short lines (common to repeat in components)
    if (trimmed.startsWith('<') || trimmed.startsWith('/>') || trimmed === '/>' ||
        (trimmed.includes('=') && trimmed.length < 40) || trimmed.length < 20) continue;
    
    const count = (seen.get(trimmed) || 0) + 1;
    seen.set(trimmed, count);
    
    if (count === 2) {
      duplicates.push(trimmed.length > 60 ? trimmed.slice(0, 57) + '...' : trimmed);
    }
  }
  
  return duplicates;
}

// TruncateOptions imported from utils/truncate

/** Format "Stored as $name" message consistently */
function formatStoredAs(name: string | undefined, suffix = ''): string {
  return name ? `Stored as $${name}${suffix}` : '';
}



// SummarizedResult imported from utils/truncate

// summarizeResult imported from utils/truncate

// MAX_SUMMARIZE_DEPTH in utils/truncate

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

// summarizeObject is internal to utils/truncate

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

// Types for lazy adapter metadata
type ParamDef = { type: string; description?: string; required?: boolean };
type MethodMeta = { name: string; description?: string; params?: Record<string, ParamDef> };

/** Parse single param: { type: "string", required?: bool, description?: "..." } */
function parseParam(block: string): ParamDef {
  const type = block.match(/type:\s*["'](\w+)["']/)?.[1] || "string";
  const required = /required:\s*true/.test(block);
  const desc = block.match(/description:\s*["']([^"']+)["']/)?.[1];
  return { type, required, description: desc };
}

/** Parse parameters block - handles nested braces */
function parseParamsBlock(content: string, start: number): Record<string, ParamDef> | undefined {
  const params: Record<string, ParamDef> = {};
  let depth = 0, blockStart = -1, paramName = "";
  
  for (let i = start; i < content.length; i++) {
    const char = content[i];
    
    if (char === "{") { depth++; if (depth === 2) blockStart = i; continue; }
    if (char === "}") {
      depth--;
      if (depth === 1 && blockStart > 0) { params[paramName] = parseParam(content.slice(blockStart, i + 1)); blockStart = -1; }
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1) continue;
    
    const nameMatch = content.slice(i).match(/^(\w+)\s*:/);
    if (nameMatch) { paramName = nameMatch[1]; i += nameMatch[0].length - 1; }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Extract method metadata from tools block */
function extractMethods(content: string): MethodMeta[] {
  const methods: MethodMeta[] = [];
  const toolsMatch = content.match(/tools:\s*\{/);
  if (!toolsMatch) return methods;
  
  // Find each method: name: { description: "...", ... }
  const methodRegex = /(\w+):\s*\{\s*description:\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(methodRegex)) {
    const paramsIdx = content.indexOf("parameters:", m.index!);
    const nextMethod = content.indexOf("\n    }", m.index! + 1);
    const hasParams = paramsIdx > 0 && paramsIdx < nextMethod;
    const params = hasParams ? parseParamsBlock(content, paramsIdx + 11) : undefined;
    methods.push({ name: m[1], description: m[2], params });
  }
  return methods;
}

/**
 * Extract adapter metadata without fully loading the module.
 */
async function extractAdapterMetadata(filePath: string): Promise<{ name: string; description?: string; domain?: string; methods: MethodMeta[] } | null> {
  try {
    const content = await Bun.file(filePath).text();

    const nameMatch = content.match(/name:\s*['"]([^'"]+)['"]/);
    if (!nameMatch) return null;

    const descMatch = content.match(/description:\s*['"]([^'"]+)['"]/);
    const domainMatch = content.match(/domain:\s*['"]([^'"]+)['"]/);
    const methods = extractMethods(content);
    return { name: nameMatch[1], description: descMatch?.[1], domain: domainMatch?.[1], methods };
  } catch {
    return null;
  }
}

/**
 * Create a lazy adapter stub that loads the full adapter on first method call.
 */
function createLazyAdapter(metadata: { name: string; description?: string; domain?: string; methods: MethodMeta[] }, filePath: string): Adapter {
  const lazyTools: Record<string, AdapterMethod> = {};

  for (const method of metadata.methods) {
    lazyTools[method.name] = {
      description: method.description || `[Lazy] Method from ${metadata.name}`,
      parameters: method.params,
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

        if (!fullAdapter?.tools[method.name]) {
          throw new Error(`Method ${method.name} not found in ${metadata.name}`);
        }

        return fullAdapter.tools[method.name].execute(params);
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


/**
 * Generate a readable signature from parameter definitions
 */
function formatSignature(
  methodName: string,
  params: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> | undefined
): string {
  if (!params || Object.keys(params).length === 0) {
    return `${methodName}()`;
  }
  const paramList = Object.entries(params)
    .map(([name, def]) => {
      const hasDefault = 'default' in def;
      const optional = def.required === false || hasDefault ? '?' : '';
      const defaultStr = hasDefault ? ` = ${JSON.stringify(def.default)}` : '';
      return `${name}${optional}: ${def.type}${defaultStr}`;
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
  paramDefs: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> | undefined
): { valid: true; correctedParams?: Record<string, unknown> } | { valid: false; error: string } {
  // No param definitions = no validation
  if (!paramDefs || Object.keys(paramDefs).length === 0) {
    return { valid: true };
  }

  const providedParams = (params && typeof params === 'object' && !Array.isArray(params))
    ? params as Record<string, unknown>
    : {};

  // Auto-correct param names before validation (lazy-init to avoid copy when not needed)
  const expectedNames = Object.keys(paramDefs);
  let correctedParams: Record<string, unknown> | null = null;

  for (const provided of Object.keys(providedParams)) {
    if (!(provided in paramDefs)) {
      const similar = findSimilarParams(provided, expectedNames);
      // Auto-correct if close match and target param not already provided
      if (similar.length > 0 && !(similar[0] in providedParams)) {
        correctedParams ??= { ...providedParams };
        correctedParams[similar[0]] = providedParams[provided]; // Use original value
        delete correctedParams[provided];
      }
    }
  }

  const finalParams = correctedParams ?? providedParams;
  const providedNames = Object.keys(finalParams);
  const errors: string[] = [];
  const hints: string[] = [];

  // Check for missing required params (skip if has default value)
  for (const [name, def] of Object.entries(paramDefs)) {
    const hasDefault = 'default' in def;
    if (def.required !== false && !hasDefault && !(name in finalParams)) {
      errors.push(`missing required '${name}'`);
    }
  }

  for (const provided of providedNames) {
    if (!(provided in paramDefs)) {
      errors.push(`unknown param '${provided}'`);
    }
  }

  // Check types for params
  for (const [name, value] of Object.entries(finalParams)) {
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

  if (errors.length === 0) {
    // Return corrected params if any corrections were made
    return correctedParams
      ? { valid: true, correctedParams: finalParams }
      : { valid: true };
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
      // Wrap execute with parameter validation and auto-correction
      methods[methodName] = async (params: unknown) => {
        const validation = validateParams(adapter.name, methodName, params, method.parameters);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
        // Use corrected params if auto-correction was applied
        const finalParams = validation.correctedParams ?? (params ?? {});
        return method.execute(finalParams as Record<string, unknown>);
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
  skills: Map<string, Skill>,
  fffSearchPath?: string
) {
  return createMcxServerCore(config, adapters, skills, fffSearchPath);
}

async function createMcxServer(fffSearchPath?: string) {
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
  const skippedCount = lazyAdapters.length - filteredLazyAdapters.length;
  const adapters = [...configAdapters, ...filteredLazyAdapters];

  // Clear message about what loaded
  const parts = [`${configAdapters.length} config`, `${filteredLazyAdapters.length} lazy`];
  if (skippedCount > 0) parts.push(`${skippedCount} skipped (in config)`);
  console.error(pc.dim(`Loaded ${parts.join(' + ')} adapter(s), ${skills.size} skill(s)`));
  return createMcxServerCore(config, adapters, skills, fffSearchPath);
}

async function createMcxServerCore(
  config: MCXConfig | null,
  adapters: Adapter[],
  skills: Map<string, Skill>,
  fffSearchPath?: string
) {
  // Cleanup stale FTS5 data on startup (older than 24h)
  try {
    const store = getContentStore();
    const cleaned = store.cleanupStale(24 * 60 * 60 * 1000);
    if (cleaned > 0) {
      console.error(pc.dim(`Cleaned up ${cleaned} stale source(s)`));
    }
  } catch {
    // Ignore cleanup errors
  }

  const sandbox = new BunWorkerSandbox({
    timeout: config?.sandbox?.timeout ?? 30000,
    memoryLimit: config?.sandbox?.memoryLimit ?? 128,
    allowAsync: true,
  });


  const FILE_HELPERS_LINE_COUNT = FILE_HELPERS_CODE.split('\n').length;
  
  // Filter out lint warnings from prepended helpers (lines in helper code, not user code)
  const filterHelperLogs = (logs: string[]) => logs.filter(log => {
    const match = log.match(/\(line (\d+)\)/);
    if (!match) return true;
    return parseInt(match[1], 10) > FILE_HELPERS_LINE_COUNT;
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

  // Execution counter
  let executionCounter = 0;

  // I/O tracking (FS reads + network)
  let fsBytesRead = 0;
  let fsFilesRead = 0;
  let networkBytesIn = 0;
  let networkRequests = 0;
  let networkBytesOut = 0;

  // Cache tracking
  let cacheHits = 0;
  let cacheBytesSaved = 0;

  // Token tracking for context efficiency stats
  const tokenStats = {
    byTool: new Map<string, { calls: number; chars: number; raw: number }>(),
    totalCalls: 0,
    totalChars: 0,
    totalRaw: 0,
    sessionStart: Date.now(),
  };

  function trackTokenOutput(toolName: string, response: MCP.CallToolResult, rawBytes?: number): MCP.CallToolResult {
    if (!response?.content) return response;  // Guard for tools without content
    
    // Sanitize all text content to remove lone surrogates that break JSON
    for (const item of response.content) {
      if (item.type === 'text' && typeof item.text === 'string') {
        item.text = sanitizeForJson(item.text);
      }
    }
    const chars = JSON.stringify(response.content).length;
    // Calculate response overhead (text wrapper, helpers, etc.) to make raw comparable to chars
    const structuredResult = (response as any).structuredContent?.result;
    const truncatedValueSize = structuredResult ? JSON.stringify(structuredResult).length : 0;
    const responseOverhead = chars - truncatedValueSize;
    // Add same overhead to rawBytes so percentages reflect actual value savings
    const raw = rawBytes ? rawBytes + responseOverhead : chars;
    const stats = tokenStats.byTool.get(toolName) || { calls: 0, chars: 0, raw: 0 };
    stats.calls++;
    stats.chars += chars;
    stats.raw += raw;
    tokenStats.byTool.set(toolName, stats);
    tokenStats.totalCalls++;
    tokenStats.totalChars += chars;
    tokenStats.totalRaw += raw;
    return response;
  }

  function trackNetworkBytes(bytesIn: number, bytesOut: number = 0): void {
    networkBytesIn += bytesIn;
    networkBytesOut += bytesOut;
  }

  function trackFsBytes(bytes: number): void {
    fsBytesRead += bytes;
  }

  function trackSandboxIO(tracking?: { fsBytes: number; fsCount: number; netBytes: number; netCount: number }): void {
    if (tracking) {
      fsBytesRead += tracking.fsBytes;
      fsFilesRead += tracking.fsCount;
      networkBytesIn += tracking.netBytes;
      networkRequests += tracking.netCount;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function generateExecutionLabel(storeAs?: string): string {
    if (storeAs) return storeAs;
    executionCounter++;
    return `exec_${executionCounter}`;
  }

  let fileFinder: FileFinder | null = null;
  
  // Multi-project watching: Map of project path -> FileFinder instance
  const watchedProjects = new Map<string, FileFinder>();



  // Background task registry
  interface BackgroundTask {
    id: string;
    code: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
    result?: unknown;
    error?: string;
    logs: string[];
  }
  let backgroundTasks: Map<string, BackgroundTask>;
  let taskIdCounter = 0;
  // MAX_BACKGROUND_TASKS imported from tools/constants.js

  /** Format task duration consistently */
  function formatTaskDuration(task: BackgroundTask, compact = false): string {
    const elapsed = (task.completedAt || Date.now()) - task.startedAt;
    const secs = (elapsed / 1000).toFixed(1);
    if (task.completedAt) return `${secs}s`;
    return compact ? `${secs}s...` : `${secs}s (running)`;
  }

  function generateTaskId(): string {
    taskIdCounter++;
    return `task_${taskIdCounter}`;
  }

  function cleanupOldTasks(): void {
    // Early exit if we're under the limit
    if (backgroundTasks.size <= MAX_BACKGROUND_TASKS) return;

    // Keep only last MAX_BACKGROUND_TASKS completed tasks
    const completed = [...backgroundTasks.entries()]
      .filter(([, t]) => t.status !== 'running')
      .sort((a, b) => (b[1].completedAt || 0) - (a[1].completedAt || 0));

    for (const [id] of completed.slice(MAX_BACKGROUND_TASKS)) {
      backgroundTasks.delete(id);
    }
  }

  async function runBackgroundTask(taskId: string, code: string): Promise<void> {
    const task = backgroundTasks.get(taskId);
    if (!task) return;

    try {
      const state = getSandboxState();
      const result = await sandbox.execute(FILE_HELPERS_CODE + code, {
        adapters: adapterContext,
        variables: state.getAllPrefixed(),
        env: config?.env || {},
      });

      task.completedAt = Date.now();
      task.logs = filterHelperLogs(result.logs || []);

      if (result.success) {
        task.status = 'completed';
        task.result = result.value;
        // Store result in state
        state.set(taskId, result.value);
      } else {
        task.status = 'failed';
        task.error = result.error?.message || 'Unknown error';
      }
    } catch (err) {
      task.completedAt = Date.now();
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
    }

    cleanupOldTasks();
  }

  // Initialize FFF (Fast File Finder) for fuzzy search - optional, graceful fallback
  let FileFinderClass: typeof import("@ff-labs/fff-bun").FileFinder | null = null;
  const fffBasePath = fffSearchPath || process.cwd();
  try {
    const { FileFinder: FF } = await import("@ff-labs/fff-bun");
    FileFinderClass = FF;
    const fffInit = FF.create({
      basePath: fffBasePath,
      frecencyDbPath: join(getMcxHomeDir(), "frecency.db"),
    });
    if (fffInit.ok) {
      fileFinder = fffInit.value;
      console.error(pc.dim(`FFF initialized for: ${fffBasePath}`));
      // Wait for initial scan (non-blocking, 5s timeout)
      fileFinder.waitForScan(5000);
      // Don't start daemon yet - wait for mcx_watch to specify projects
    } else {
      console.error(pc.yellow(`FFF init skipped: ${fffInit.error}`));
    }
  } catch (err) {
    console.error(pc.yellow(`FFF not available (native binary missing) - mcx_find/mcx_grep disabled`));
  }

  // LRU cache for external path finders (max 5 entries, 5 min TTL)
  const FINDER_CACHE_MAX = 5;
  const FINDER_CACHE_TTL_MS = 5 * 60 * 1000;
  const finderCache = new Map<string, { finder: FileFinder; lastAccess: number }>();
  const finderCreating = new Set<string>(); // Prevent concurrent creation

  /** Clean expired entries from cache */
  function cleanExpiredFinders(): void {
    const now = Date.now();
    for (const [key, val] of finderCache) {
      if (now - val.lastAccess >= FINDER_CACHE_TTL_MS) {
        val.finder.destroy();
        finderCache.delete(key);
      }
    }
  }

  /** Get or create cached finder for external path */
  async function getCachedFinder(searchPath: string): Promise<FileFinder | null> {
    if (!FileFinderClass) return null;

    // Clean expired entries on each access
    cleanExpiredFinders();

    const now = Date.now();
    const cached = finderCache.get(searchPath);

    // Return cached if exists (TTL already checked by cleanExpiredFinders)
    if (cached) {
      cached.lastAccess = now;
      return cached.finder;
    }

    // Prevent concurrent creation for same path
    if (finderCreating.has(searchPath)) {
      // Wait briefly and retry (simple spinlock)
      await new Promise(r => setTimeout(r, 100));
      return getCachedFinder(searchPath);
    }

    finderCreating.add(searchPath);
    try {
      // Evict LRU if at capacity
      if (finderCache.size >= FINDER_CACHE_MAX) {
        let oldest: string | null = null;
        let oldestTime = Infinity;
        for (const [key, val] of finderCache) {
          if (val.lastAccess < oldestTime) {
            oldestTime = val.lastAccess;
            oldest = key;
          }
        }
        if (oldest) {
          finderCache.get(oldest)?.finder.destroy();
          finderCache.delete(oldest);
        }
      }

      // Create new finder
      const init = FileFinderClass.create({ basePath: searchPath });
      if (!init.ok) return null;
      init.value.waitForScan(3000);
      finderCache.set(searchPath, { finder: init.value, lastAccess: now });
      return init.value;
    } catch {
      return null;
    } finally {
      finderCreating.delete(searchPath);
    }
  }

  type McpResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

  /** Execute search with finder, handling external paths (cached) */
  async function withFinder<T>(
    searchPath: string | undefined,
    fn: (finder: FileFinder) => T | Promise<T>
  ): Promise<T | McpResult> {
    // Normalize paths for comparison
    const normalizedSearch = searchPath ? path.resolve(searchPath) : null;
    const normalizedBase = path.resolve(fffBasePath);

    let finder: FileFinder | null;

    if (normalizedSearch && normalizedSearch !== normalizedBase) {
      // First check watchedProjects (already initialized by mcx_watch)
      finder = watchedProjects.get(normalizedSearch) || null;
      
      // If not in watchedProjects, use cached finder (creates new if needed)
      if (!finder) {
        finder = await getCachedFinder(normalizedSearch);
      }
      
      if (!finder) {
        return { content: [{ type: "text" as const, text: `Failed to initialize search in: ${searchPath}` }], isError: true };
      }

    } else {
      finder = fileFinder;
      if (!finder) {
        return { content: [{ type: "text" as const, text: "FFF not initialized. Run from a project directory." }], isError: true };
      }
    }

    return fn(finder);
  }

  const server = new McpServer({
    name: "mcx-mcp-server",
    version: "0.1.0",
  });

  // Wrap registerTool to track all tool outputs
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: any, handler: any) => {
    const trackedHandler = async (params: any) => {
      const result = await handler(params);
      // Extract _rawBytes if present (tools set this to track pre-truncation size)
      const rawBytes = (result as any)._rawBytes;
      if (rawBytes !== undefined) delete (result as any)._rawBytes;
      return trackTokenOutput(name, result, rawBytes);
    };
    return originalRegisterTool(name, config, trackedHandler);
  }) as typeof server.registerTool;

  // Register all extracted tools via centralized registration
  const toolContext = await createToolContext({
    basePath: fffBasePath,
    spec: cachedSpec,
    sandbox,
    cleanupOnStart: false, // Already cleaned up above
    adapterContext,
  });
  // Use backgroundTasks from toolContext (ONE source of truth)
  backgroundTasks = toolContext.backgroundTasks;
  
  registerExtractedTools({
    server,
    ctx: toolContext,
    skills,
    withFinder,
  });



  return {
    server,
    cleanup: () => {
      stopDaemon();
      fileFinder?.destroy();
    },
  };
}

// ============================================================================
// Transports
// ============================================================================

async function runStdio(fffSearchPath?: string) {

  // Load global ~/.mcx/.env
  await loadEnvFile();

  console.error(pc.cyan("Starting MCX MCP server (stdio)...\n"));

  const { server, cleanup } = await createMcxServer(fffSearchPath);
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
  console.error(pc.dim("Tools: mcx_execute, mcx_adapter, mcx_search, mcx_tasks, mcx_file, mcx_edit, mcx_write, mcx_fetch, mcx_stats, mcx_watch, mcx_doctor, mcx_upgrade, mcx_find, mcx_grep"));
  console.error(pc.dim(`Logs: ${logger.getLogPath()}`));
}

async function runHttp(port: number, fffSearchPath?: string) {

  // Load global ~/.mcx/.env
  await loadEnvFile();

  console.error(pc.cyan(`Starting MCX MCP server (HTTP:${port})...\n`));

  const config = await loadConfig();
  const skills = await loadSkills();
  const adapters = config?.adapters || [];
  console.error(pc.dim(`Loaded ${adapters.length} adapter(s), ${skills.size} skill(s)`));

  // PERFORMANCE: Create server and transport ONCE, reuse for all requests
  // This prevents resource exhaustion from creating new instances per request
  const { server, cleanup } = await createMcxServerWithDeps(config, adapters, skills, fffSearchPath);
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
          // MAX_RESPONSE_BODY imported from tools/constants.js

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
    // Default: use global ~/.mcx/ directory for config, adapters, and FFF
    const mcxHome = ensureMcxHomeDir();
    console.error(pc.dim(`[MCX] Config from: ${mcxHome}`));
    process.chdir(mcxHome);
  }

  if (options.transport === "http") {
    await runHttp(options.port || 3100);
  } else {
    await runStdio();
  }
}