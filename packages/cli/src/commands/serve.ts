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

import * as path from "node:path";
import { join, basename, extname, isAbsolute, resolve } from "node:path";

// Hoisted regex for import extraction (avoids recreation per call)
const IMPORT_REGEX = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pc from "picocolors";
import { BunWorkerSandbox, generateTypesSummary } from "@papicandela/mcx-core";

import { getMcxHomeDir, getAdaptersDir, ensureMcxHomeDir, findProjectRoot } from "../utils/paths";
import { startDaemon, stopDaemon } from "../daemon";
import { type FileFinder, isExcludedPath } from "../utils/fff";
import { coerceJsonArray } from "../utils/zod";
import { isDangerousEnvKey, isBlockedUrl } from "../utils/security";
import { logger } from "../utils/logger";
import { getContentStore, searchWithFallback, getDistinctiveTerms, batchSearch, htmlToMarkdown, isHtml } from "../search";
import { getSandboxState } from "../sandbox";
import { loadSpecsFromAdapters } from "../spec";

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
// Zod Schemas
// ============================================================================

const ExecuteInputSchema = z.object({
  code: z.string()
    .optional()
    .describe("JavaScript/TypeScript code to execute in the sandbox"),
  shell: z.string()
    .optional()
    .describe("Shell command to execute (bash/sh). Returns stdout, stderr, exitCode."),
  truncate: z.boolean()
    .optional()
    .default(true)
    .describe("Whether to truncate large results (default: true)"),
  maxItems: z.coerce.number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(10)
    .describe("Max array items to return when truncating (default: 10, max: 1000)"),
  maxStringLength: z.coerce.number()
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
  timeout: z.coerce.number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .default(30000)
    .describe("Shell command timeout in ms (default: 30000, max: 300000)"),
}).strict().refine(
  data => data.code || data.shell,
  "Either code or shell must be provided"
).refine(
  data => !(data.code && data.shell),
  "Cannot use both code and shell - choose one"
);

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
  maxItems: z.coerce.number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .default(10)
    .describe("Max array items to return when truncating (default: 10, max: 1000)"),
  maxStringLength: z.coerce.number()
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
  maxItems: z.coerce.number()
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
  queries: coerceJsonArray(z.array(z.string()))
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
  limit: z.coerce.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Max number of results per category (default: 20, max: 100)"),
  storeAs: z.string()
    .optional()
    .describe("Store result as variable (e.g., 'methods' → access as $methods). Returns summary instead of full result."),
  clear: z.boolean()
    .optional()
    .describe("Clear all indexed content (FTS5). Use to free memory or start fresh."),
}).strict();

const BatchInputSchema = z.object({
  commands: coerceJsonArray(z.array(z.object({
    label: z.string().describe("Label for this command (used as section header)"),
    command: z.string().describe("Shell command to execute"),
  })))
    .optional()
    .describe("Array of shell commands to run with labels"),
  operations: coerceJsonArray(z.array(z.object({
    code: z.string().describe("Code to execute"),
    storeAs: z.string().optional().describe("Variable name to store result"),
  })))
    .optional()
    .describe("Array of code operations to run sequentially"),
  executions: coerceJsonArray(z.array(z.object({
    code: z.string().describe("Code to execute"),
    storeAs: z.string().optional().describe("Variable name to store result"),
  })))
    .optional()
    .describe("Deprecated alias for operations"),
  queries: coerceJsonArray(z.array(z.string()))
    .optional()
    .describe("FTS5 search queries to run on indexed content"),
  source: z.string()
    .optional()
    .describe("Filter searches to specific source label"),
  timeout: z.coerce.number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .default(30000)
    .describe("Timeout per command in ms (default: 30000)"),
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
/** Threshold for warning about full-file returns in mcx_file */
const FULL_FILE_WARNING_BYTES = 5000;
/** Code patterns that return entire file content (anti-pattern) */
const FULL_FILE_CODE = new Set(['$file', '$file.text', '$file.lines']);
/** Threshold for auto-indexing file content in mcx_file (10KB) */
const FILE_INDEX_THRESHOLD = 10_000;
/** Threshold for auto-indexing large outputs without intent (50KB) */
const AUTO_INDEX_THRESHOLD = 50_000;
/** Hard cap on shell/process output to prevent OOM (100MB) */
const HARD_CAP_BYTES = 100 * 1024 * 1024;
/** Cross-platform shell path */
const SHELL_PATH = process.platform === 'win32' 
  ? 'C:\\Program Files\\Git\\bin\\sh.exe' 
  : '/bin/sh';

/**
 * Kill process and all its children (tree kill).
 * On Windows, proc.kill() doesn't kill child processes, leaving zombies.
 */
function killTree(proc: { pid: number; kill: () => void }): void {
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills entire process tree, /F forces termination
      Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(proc.pid)], { 
        stdout: 'ignore', 
        stderr: 'ignore' 
      });
    } else {
      // On Unix, kill process group (negative PID)
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Fallback to regular kill if process group kill fails
        killTree(proc);
      }
    }
  } catch {
    // Last resort fallback
    killTree(proc);
  }
}

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
/** Get safe environment for shell execution (filters dangerous vars) */
function getSafeEnv(): Record<string, string> {
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !DENIED_ENV.has(key) && !key.includes('SECRET') && !key.includes('PASSWORD') && !key.includes('TOKEN') && !key.includes('CREDENTIAL')) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}
/** Search throttling: normal results up to this many calls */
const THROTTLE_AFTER = 3;
/** Search throttling: block after this many calls */
const BLOCK_AFTER = 8;
/** Search throttling window in ms */
const THROTTLE_WINDOW_MS = 60_000;
/** File access tracking for progressive tips (Optimization #2+#3) */
const fileAccessLog = new Map<string, { count: number; firstAccess: number }>();
/** Track when files were stored with storeAs (for stale line number detection) */
const fileStoreTime = new Map<string, number>();
/** Track when files were edited (for stale line number detection) */
const fileEditTime = new Map<string, number>();

/** Track execution failures for retry loop detection (Pattern D) */
const executeFailures = new Map<string, { count: number; lastTime: number; lastError: string }>();

/** Grep call tracking for progressive tips (Optimization #9) */
const grepCallLog = { count: 0, firstCall: 0 };

/** TTL for Map cleanup (30 minutes) */
const MAP_TTL_MS = 30 * 60 * 1000;
/** Max entries per Map to prevent unbounded growth */
const MAP_MAX_ENTRIES = 500;

/** Cleanup stale Map entries (called periodically) */
function cleanupStaleMaps(): void {
  const now = Date.now();
  
  // Clean fileAccessLog (entries older than TTL)
  for (const [key, val] of fileAccessLog) {
    if (now - val.firstAccess > MAP_TTL_MS) fileAccessLog.delete(key);
  }
  
  // Clean fileStoreTime and fileEditTime
  for (const [key, time] of fileStoreTime) {
    if (now - time > MAP_TTL_MS) fileStoreTime.delete(key);
  }
  for (const [key, time] of fileEditTime) {
    if (now - time > MAP_TTL_MS) fileEditTime.delete(key);
  }
  
  // Clean executeFailures
  for (const [key, val] of executeFailures) {
    if (now - val.lastTime > MAP_TTL_MS) executeFailures.delete(key);
  }
  
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

/** Get signature for code (first 100 chars normalized) */
function getCodeSignature(code: string): string {
  return code.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Workflow tracking for inefficiency detection (Optimization #5) */
const sessionWorkflow = {
  lastTools: [] as Array<{ tool: string; file?: string; timestamp: number }>,
  maxHistory: 10,
};

/** Detect inefficient usage patterns and return suggestion */
function detectInefficiency(tool: string, file?: string): string | null {
  const recent = sessionWorkflow.lastTools.slice(-5);
  if (recent.length < 2) return null;

  // Pattern: Edit → Read same file (no need to re-read after edit)
  // BUT: if file was edited after storeAs, user DOES need to re-read for line mode
  const last = recent[recent.length - 1];
  const storeTime = file ? fileStoreTime.get(file) : undefined;
  const editTime = file ? fileEditTime.get(file) : undefined;
  const needsReloadForLineMode = storeTime && editTime && editTime > storeTime;

  if (tool === 'mcx_file' && file && last?.tool === 'mcx_edit' && last?.file === file) {
    // Don't warn if user needs to reload for line mode to work
    if (!needsReloadForLineMode) {
      return `💡 Edit was successful. No need to re-read "${file}" to verify.`;
    }
  }

  // Pattern: Read → Edit → Read same file
  if (tool === 'mcx_file' && file && recent.length >= 2) {
    const prev = recent[recent.length - 2];
    if (last?.tool === 'mcx_edit' && last?.file === file && 
        prev?.tool === 'mcx_file' && prev?.file === file) {
      // Don't warn if user needs to reload for line mode to work
      if (!needsReloadForLineMode) {
        return `💡 You just edited "${file}". The edit succeeded - no need to re-read.`;
      }
    }
  }

  // Pattern: Multiple greps - now handled by progressive tips in mcx_grep handler (Optimization #9)

  // Pattern: Same file read 3+ times WITHOUT edits (suggest storeAs or reuse)
  // Skip if user needs to reload after edit (that's legitimate)
  if (tool === 'mcx_file' && file && !needsReloadForLineMode) {
    const sameFileReads = recent.filter(t => t.tool === 'mcx_file' && t.file === file);
    const hasEditBetween = recent.some(t => t.tool === 'mcx_edit' && t.file === file);
    // Only warn if reading 3+ times without edits (pure read inefficiency)
    if (sameFileReads.length >= 2 && !hasEditBetween) {
      // Check if file was already stored (has storeTime)
      const alreadyStored = storeTime !== undefined;
      if (alreadyStored) {
        return `💡 File already loaded. Use existing variable and helpers instead of re-reading.`;
      }
      return `💡 Reading "${basename(file)}" again. Use storeAs to keep it in memory.`;
    }
  }

  // Pattern H: Detect edit→build/test→edit cycle (suggest batching edits before running build)
  // Only triggers when mcx_execute (build/lint/test) is run between edits, NOT for mcx_file reads
  if (tool === 'mcx_edit' && file && recent.length >= 2) {
    const prevEditIdx = recent.findLastIndex(t => t.tool === 'mcx_edit' && t.file === file);
    
    if (prevEditIdx >= 0 && prevEditIdx < recent.length - 1) {
      // Only check for mcx_execute (build/test commands), not mcx_file (legitimate reloads)
      const betweenTools = recent.slice(prevEditIdx + 1).map(t => t.tool);
      const hasBuildOrTest = betweenTools.includes('mcx_execute');
      if (hasBuildOrTest) {
        return `💡 Edit→build→edit cycle detected. Batch all edits first, then run build/test once at the end.`;
      }
    }
  }

  // Pattern: 5+ unique files read without processing (suggest mcx_batch or storeAs)
  if (tool === 'mcx_file') {
    const recentFileReads = sessionWorkflow.lastTools.filter(t => 
      t.tool === 'mcx_file' && t.file && Date.now() - t.timestamp < 120000 // last 2 min
    );
    const uniqueFiles = new Set(recentFileReads.map(t => t.file));
    if (uniqueFiles.size >= 5) {
      const hasExecute = sessionWorkflow.lastTools.some(t => 
        t.tool === 'mcx_execute' && Date.now() - t.timestamp < 120000
      );
      if (!hasExecute) {
        return `⚠️ Reading ${uniqueFiles.size} files without processing.\n` +
               `Consider: mcx_batch({ commands: [...] }) or process each file with code.`;
      }
    }
  }

  return null;
}

/** Track tool usage for workflow detection */
function trackToolUsage(tool: string, file?: string): void {
  sessionWorkflow.lastTools.push({ tool, file, timestamp: Date.now() });
  if (sessionWorkflow.lastTools.length > sessionWorkflow.maxHistory) {
    sessionWorkflow.lastTools.shift();
  }
}

/** Max params to show in full (above this, truncate) */
const MAX_PARAMS_FULL = 10;
/** Max params to show when truncating */
const MAX_PARAMS_TRUNCATED = 8;
/** Max description length before truncating */
const MAX_DESC_LENGTH = 80;
/** Max log lines to show */
const MAX_LOGS = 20;

/** Tool pair suggestions - maps tool to complementary tools */
const TOOL_PAIRS: Record<string, { tool: string; hint: string }[]> = {
  mcx_find: [
    { tool: "mcx_grep", hint: "search content in found files" },
    { tool: "mcx_file", hint: "process a found file" },
    { tool: "mcx_related", hint: "find imports/exports" },
  ],
  mcx_grep: [
    { tool: "mcx_file", hint: "process matched file" },
    { tool: "mcx_related", hint: "find related files" },
  ],
  mcx_file: [
    { tool: "mcx_related", hint: "find imports/exports" },
    { tool: "mcx_tree", hint: "navigate large JSON" },
    { tool: "mcx_edit", hint: "edit the file" },
  ],
  mcx_edit: [
    { tool: "mcx_related", hint: "check related files" },
  ],
  mcx_write: [
    { tool: "mcx_related", hint: "find files that may import this" },
  ],
  mcx_batch: [
    { tool: "mcx_tree", hint: "navigate large results" },
    { tool: "mcx_related", hint: "find related files" },
  ],
  mcx_fetch: [
    { tool: "mcx_search", hint: "search indexed content" },
    { tool: "mcx_tree", hint: "navigate JSON response" },
  ],
  mcx_execute: [
    { tool: "mcx_search", hint: "search results or find methods" },
    { tool: "mcx_tree", hint: "navigate large results" },
  ],
  mcx_search: [
    { tool: "mcx_execute", hint: "call discovered method" },
    { tool: "mcx_tree", hint: "navigate results" },
  ],
  mcx_related: [
    { tool: "mcx_file", hint: "process related file" },
    { tool: "mcx_grep", hint: "search in related files" },
  ],
  mcx_tree: [
    { tool: "mcx_file", hint: "process with code" },
  ],
};

/** Pre-computed tool suggestions (memoized at load time) */
const TOOL_SUGGESTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_PAIRS).map(([tool, pairs]) => [
    tool,
    `\n→ Next: ${pairs.map(p => `${p.tool} (${p.hint})`).join(", ")}`
  ])
);

/** Get tool suggestion line (memoized) */
function suggestNextTool(toolName: string): string {
  return TOOL_SUGGESTIONS[toolName] || "";
}

/** Escape FTS5 special characters in query */
function escapeFts5Query(query: string): string {
  return query.replace(/[.:"'()]/g, ' ').trim();
}

/** Format batch search results for output, returns total match count */
function formatSearchResults(
  batchResults: Record<string, { snippet: string }[]>,
  output: string[]
): number {
  let totalMatches = 0;
  for (const [query, results] of Object.entries(batchResults)) {
    totalMatches += results.length;
    if (results.length === 0) {
      output.push(`  "${query}": no matches`);
    } else {
      output.push(`  "${query}" (${results.length} matches):`);
      for (const r of results.slice(0, 3)) {
        output.push(`    ${extractSnippet(r.snippet, query, 300)}`);
        output.push('');
      }
    }
  }
  return totalMatches;
}

/** Last accessed directory for proximity reranking */
let lastAccessedDir: string | null = null;

/** Update last accessed directory from a file path */
function updateProximityContext(filePath: string): void {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  lastAccessedDir = lastSlash > 0 ? normalized.slice(0, lastSlash) : null;
}

/** Calculate proximity score (0-1) based on shared path prefix */
function getProximityScore(filePath: string): number {
  if (!lastAccessedDir) return 0;
  const normalized = filePath.replace(/\\/g, "/");
  const fileDir = normalized.slice(0, normalized.lastIndexOf("/"));
  if (fileDir === lastAccessedDir) return 1; // Same directory
  // Check shared prefix depth
  const contextParts = lastAccessedDir.split("/");
  const fileParts = fileDir.split("/");
  let shared = 0;
  for (let i = 0; i < Math.min(contextParts.length, fileParts.length); i++) {
    if (contextParts[i] === fileParts[i]) shared++;
    else break;
  }
  return shared / Math.max(contextParts.length, fileParts.length);
}

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
 * Format mcx_file result compactly (Optimization #10).
 * - Array of strings → numbered lines (detects offset from slice())
 * - Long string → truncate long lines
 * - Other types → JSON
 */
function formatFileResult(result: unknown, code: string): string {
  const MAX_LINE_WIDTH = 120;
  
  // Array of strings (lines) → format with numbers
  if (Array.isArray(result) && result.length > 0 && result.every(r => typeof r === 'string')) {
    // Check if lines are already numbered (format "N: content")
    const firstLine = result[0] as string;
    const alreadyNumbered = /^\d+:\s/.test(firstLine);
    
    if (alreadyNumbered) {
      // Lines already numbered - just truncate long ones
      return result
        .map((line: string) => line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH - 3) + '...' : line)
        .join('\n');
    }
    
    // Lines NOT numbered - detect offset from slice() and add numbers
    // Patterns: .slice(N), .slice(N,M), lines.slice(N)
    const sliceMatch = code.match(/\.slice\s*\(\s*(\d+)/);
    const offset = sliceMatch ? parseInt(sliceMatch[1], 10) : 0;
    
    return result
      .map((line: string, i: number) => {
        const numbered = `${offset + i + 1}: ${line}`;
        return numbered.length > MAX_LINE_WIDTH ? numbered.slice(0, MAX_LINE_WIDTH - 3) + '...' : numbered;
      })
      .join('\n');
  }
  
  // String → return directly with line truncation (like formatToolResult)
  if (typeof result === 'string') {
    return result
      .replace(/\r\n/g, '\n')  // Normalize Windows line endings
      .split('\n')
      .map(line => line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH - 3) + '...' : line)
      .join('\n');
  }
  
  // Other types: JSON
  return safeStringify(result);
}

/**
 * Format tool result for readable output (Optimization #11b).
 * - String → return directly with line truncation
 * - Array of strings → join with newlines
 * - Object/Array → compact JSON
 */
function formatToolResult(value: unknown, maxWidth: number = 120): string {
  // Null/undefined
  if (value === null || value === undefined) {
    return String(value);
  }
  
  // String → normalize CRLF, truncate long lines
  if (typeof value === 'string') {
    return value
      .replace(/\r\n/g, '\n')  // Normalize Windows line endings
      .split('\n')
      .map(line => line.length > maxWidth ? line.slice(0, maxWidth - 3) + '...' : line)
      .join('\n');
  }
  
  // Array of strings → join with newlines
  if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string')) {
    return (value as string[])
      .map(line => {
        const clean = typeof line === 'string' ? line.replace(/\r/g, '') : String(line);
        return clean.length > maxWidth ? clean.slice(0, maxWidth - 3) + '...' : clean;
      })
      .join('\n');
  }
  
  // Object/Array → compact JSON (indent=2 for readability but not excessive)
  return safeStringify(value, 2);
}

/**
 * Extract a smart snippet with window around the match (Smart Snippets feature)
 * Instead of truncating from start, finds the match and extracts context around it.
 */
function extractSnippet(text: string, query: string, windowSize: number = 300): string {
  const lower = text.toLowerCase();
  // Split query into words and find first match
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  let matchIdx = -1;
  let matchedWord = query;
  
  // Find first matching word
  for (const word of queryWords) {
    const idx = lower.indexOf(word);
    if (idx !== -1 && (matchIdx === -1 || idx < matchIdx)) {
      matchIdx = idx;
      matchedWord = word;
    }
  }
  
  // Fallback to simple query match
  if (matchIdx === -1) {
    matchIdx = lower.indexOf(query.toLowerCase());
  }
  
  // No match found - return from start
  if (matchIdx === -1) {
    return text.length <= windowSize 
      ? text 
      : text.slice(0, windowSize) + '...';
  }
  
  // Calculate window around match
  const halfWindow = Math.floor(windowSize / 2);
  const start = Math.max(0, matchIdx - halfWindow);
  const end = Math.min(text.length, matchIdx + matchedWord.length + halfWindow);
  
  // Extract and add ellipsis if truncated
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  
  return prefix + text.slice(start, end).trim() + suffix;
}



/**
 * Enforce character limit on text output
 */
function enforceCharacterLimit(text: string, limit: number = CHARACTER_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  const truncatedText = text.slice(0, limit) + `\n\n... [Response truncated at ${limit} chars, original was ${text.length}]`;
  return { text: truncatedText, truncated: true };
}

/** Threshold for raw data warning */
const RAW_DATA_THRESHOLD = 10000;

/**
 * Detect if result looks like unfiltered raw data that should be processed
 * Returns warning message if raw data detected, null otherwise
 */
function detectRawData(value: unknown, serializedLength: number): string | null {
  if (serializedLength < RAW_DATA_THRESHOLD) return null;
  
  // Array with many objects (likely API response)
  if (Array.isArray(value) && value.length > 20) {
    const firstItem = value[0];
    if (firstItem && typeof firstItem === 'object') {
      const keys = Object.keys(firstItem);
      
      // Detect common patterns and suggest contextual templates
      const hasId = keys.some(k => k.toLowerCase().includes('id'));
      const hasName = keys.some(k => k.toLowerCase().includes('name') || k.toLowerCase().includes('title'));
      const hasStatus = keys.some(k => k.toLowerCase().includes('status') || k.toLowerCase().includes('state'));
      const hasDate = keys.some(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('created') || k.toLowerCase().includes('updated'));
      const hasAmount = keys.some(k => k.toLowerCase().includes('amount') || k.toLowerCase().includes('price') || k.toLowerCase().includes('total'));
      
      const suggestions: string[] = [];
      
      // Build contextual suggestions based on detected fields
      if (hasId && hasName) {
        suggestions.push(`pick($result, ['${keys.find(k => k.toLowerCase().includes('id'))}', '${keys.find(k => k.toLowerCase().includes('name') || k.toLowerCase().includes('title'))}'])`);
      }
      if (hasStatus) {
        const statusKey = keys.find(k => k.toLowerCase().includes('status') || k.toLowerCase().includes('state'));
        suggestions.push(`count($result, '${statusKey}')`);
      }
      if (hasAmount) {
        const amountKey = keys.find(k => k.toLowerCase().includes('amount') || k.toLowerCase().includes('price') || k.toLowerCase().includes('total'));
        suggestions.push(`sum($result, '${amountKey}')`);
      }
      if (hasDate) {
        suggestions.push(`first($result.sort((a,b) => new Date(b.${keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('created'))}) - new Date(a.${keys.find(k => k.toLowerCase().includes('date') || k.toLowerCase().includes('created'))})), 10)`);
      }
      
      if (suggestions.length === 0) {
        suggestions.push(`pick($result, ['${keys.slice(0, 2).join("', '")}'])`);
        suggestions.push('first($result, 10)');
      }
      
      return `⚠️ Large array (${value.length} items, ${Math.round(serializedLength/1024)}KB). Try:\n` +
             suggestions.slice(0, 3).map(s => `   • ${s}`).join('\n');
    }
  }
  
  // Large object with many keys
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length > 20) {
      return `⚠️ Large object (${keys.length} keys, ${Math.round(serializedLength/1024)}KB). Try:\n` +
             `   • $result.${keys[0]} — access specific key\n` +
             `   • pick($result, ['${keys.slice(0, 3).join("', '")}'])`;
    }
  }
  
  return null;
}

/**
 * Check brace balance in code content
 * Returns 0 if balanced, positive if too many opening, negative if too many closing
 */
function checkBraceBalance(content: string): number {
  let balance = 0;
  let inString = false;
  let stringChar = '';
  let escaped = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const prev = i > 0 ? content[i - 1] : '';
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    if (inString) {
      if (char === stringChar && prev !== '\\') {
        inString = false;
      }
      continue;
    }
    
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }
    
    if (char === '{') balance++;
    if (char === '}') balance--;
  }
  
  return balance;
}

/**
 * Find duplicate lines near the edit location
 * Returns array of duplicate line contents
 */
function findDuplicatesNear(content: string, editStart: number, windowSize: number = 10): string[] {
  const lines = content.split('\n');
  const start = Math.max(0, editStart - windowSize);
  const end = Math.min(lines.length, editStart + windowSize);
  
  const window = lines.slice(start, end);
  const seen = new Map<string, number>();
  const duplicates: string[] = [];
  
  for (const line of window) {
    const trimmed = line.trim();
    // Skip empty lines, comments, and simple braces
    if (!trimmed || trimmed === '{' || trimmed === '}' || trimmed.startsWith('//')) continue;
    
    const count = (seen.get(trimmed) || 0) + 1;
    seen.set(trimmed, count);
    
    if (count === 2) {
      duplicates.push(trimmed.length > 60 ? trimmed.slice(0, 57) + '...' : trimmed);
    }
  }
  
  return duplicates;
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
  rawBytes: number;  // Size before truncation for token tracking
}

function summarizeResult(value: unknown, opts: TruncateOptions): SummarizedResult {
  // Calculate raw size before any truncation
  const rawBytes = JSON.stringify(value).length;
  
  if (!opts.enabled) {
    return { value, truncated: false, rawBytes };
  }

  if (value === undefined || value === null) {
    return { value, truncated: false, rawBytes };
  }

  // Create a shared seen set for circular reference detection
  const seen = new WeakSet<object>();

  if (Array.isArray(value)) {
    if (value.length > opts.maxItems) {
      return {
        value: value.slice(0, opts.maxItems).map(v => summarizeObject(v, opts, 0, seen)),
        truncated: true,
        originalSize: `${value.length} items, showing first ${opts.maxItems}`,
        rawBytes,
      };
    }
    return { value: value.map(v => summarizeObject(v, opts, 0, seen)), truncated: false, rawBytes };
  }

  if (typeof value === "object") {
    return { value: summarizeObject(value, opts, 0, seen), truncated: false, rawBytes };
  }

  if (typeof value === "string" && value.length > opts.maxStringLength) {
    return {
      value: `${value.slice(0, opts.maxStringLength)}... [${value.length} chars]`,
      truncated: true,
      originalSize: `${value.length} chars`,
      rawBytes,
    };
  }

  return { value, truncated: false, rawBytes };
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
  const adapters = [...configAdapters, ...filteredLazyAdapters];

  console.error(pc.dim(`Loaded ${configAdapters.length} config + ${filteredLazyAdapters.length} lazy adapter(s), ${skills.size} skill(s)`));
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

  // File helpers code to prepend to user code (functions can't be passed via postMessage)
  const FILE_HELPERS_CODE = `
const isNumbered = (lines) => lines.length > 0 && /^\\d+:\\s/.test(lines[0]);
const around = (stored, line, ctx = 10) => {
  const start = Math.max(0, line - ctx - 1);
  const end = Math.min(stored.lines.length, line + ctx);
  const slice = stored.lines.slice(start, end);
  if (isNumbered(stored.lines)) return slice.join('\\n');
  return slice.map((l, i) => (start + i + 1) + ':\\t' + l).join('\\n');
};
const lines = (stored, start, end) => {
  const slice = stored.lines.slice(start - 1, end);
  if (isNumbered(stored.lines)) return slice.join('\\n');
  return slice.map((l, i) => (start + i) + ':\\t' + l).join('\\n');
};
const block = (stored, line) => {
  const lns = stored.lines;
  let blockStart = line - 1, blockEnd = line - 1, braceCount = 0;
  for (let i = line - 1; i >= 0; i--) {
    if (lns[i].includes('{')) braceCount++;
    if (lns[i].includes('}')) braceCount--;
    if (braceCount > 0 || /^(\\d+:\\s*)?(export\\s+)?(async\\s+)?(function|class|const|interface|type)\\s+\\w+/.test(lns[i])) {
      blockStart = i; break;
    }
  }
  braceCount = 0;
  for (let i = blockStart; i < lns.length; i++) {
    for (const ch of lns[i]) { if (ch === '{') braceCount++; if (ch === '}') braceCount--; }
    blockEnd = i;
    if (braceCount <= 0 && i > blockStart) break;
  }
  const slice = lns.slice(blockStart, blockEnd + 1);
  if (isNumbered(lns)) return slice.join('\\n');
  return slice.map((l, i) => (blockStart + i + 1) + ':\\t' + l).join('\\n');
};
const grep = (stored, pattern) => {
  const re = new RegExp(pattern, 'gi');
  const matches = stored.lines.map((l, i) => [l, i]).filter(([l]) => re.test(l));
  if (isNumbered(stored.lines)) return matches.map(([l]) => l).join('\\n');
  return matches.map(([l, i]) => (i + 1) + ':\\t' + l).join('\\n');
};
const outline = (stored) => {
  const pat = isNumbered(stored.lines) 
    ? /^\\d+:\\s*(export\\s+)?(async\\s+)?(function|class|const|interface|type)\\s+\\w+/
    : /^(export\\s+)?(async\\s+)?(function|class|const|interface|type)\\s+\\w+/;
  const matches = stored.lines.map((l, i) => [l, i]).filter(([l]) => pat.test(l));
  if (isNumbered(stored.lines)) return matches.map(([l]) => l).join('\\n');
  return matches.map(([l, i]) => (i + 1) + ':\\t' + l).join('\\n');
};
const head = (stored, n = 20) => {
  const slice = stored.lines.slice(0, n);
  if (isNumbered(stored.lines)) return slice.join('\\n');
  return slice.map((l, i) => (i + 1) + ':\\t' + l).join('\\n');
};
const tail = (stored, n = 20) => {
  const total = stored.lines.length;
  const start = Math.max(0, total - n);
  const slice = stored.lines.slice(start);
  if (isNumbered(stored.lines)) return slice.join('\\n');
  return slice.map((l, i) => (start + i + 1) + ':\\t' + l).join('\\n');
};
const grepContext = (stored, pattern, ctx = 5) => {
  const re = new RegExp(pattern, 'gi');
  const lns = stored.lines;
  const matchIndices = lns.map((l, i) => re.test(l) ? i : -1).filter(i => i >= 0);
  if (matchIndices.length === 0) return 'No matches';
  const ranges = [];
  for (const idx of matchIndices) {
    const start = Math.max(0, idx - ctx);
    const end = Math.min(lns.length - 1, idx + ctx);
    if (ranges.length > 0 && ranges[ranges.length - 1].end >= start - 1) {
      ranges[ranges.length - 1].end = end;
    } else {
      ranges.push({ start, end, match: idx });
    }
  }
  const output = [];
  for (const r of ranges) {
    const slice = lns.slice(r.start, r.end + 1);
    if (isNumbered(lns)) {
      output.push(slice.join('\\n'));
    } else {
      output.push(slice.map((l, i) => (r.start + i + 1) + ':\\t' + l).join('\\n'));
    }
  }
  return output.join('\\n---\\n');
};
// JSON helpers (for parsed objects with __raw)
const keys = (obj) => Object.keys(obj).filter(k => k !== '__raw');
const values = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== '__raw'));
const pick = (obj, ks) => Object.fromEntries(ks.map(k => [k, obj[k]]));
const paths = (obj, prefix = '', _depth = 0) => {
  if (_depth > 5) return [];
  const result = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__raw') continue;
    const path = prefix ? prefix + '.' + k : k;
    result.push(path);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      result.push(...paths(v, path, _depth + 1));
    }
  }
  if (_depth > 0) return result;
  return result.slice(0, 50).join('\\n') + (result.length > 50 ? '\\n... +' + (result.length - 50) : '');
};
`;

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

  // Method frecency tracker - counts adapter.method usage for search ranking
  const methodUsage = new Map<string, number>();
  const METHOD_USAGE_CAP = 500; // Prevent unbounded growth in long sessions
  const METHOD_PATTERN = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  const adapterNamesCache = new Set(Object.keys(adapterContext || {}));
  let fileFinder: FileFinder | null = null; // Forward declaration for trackMethodUsage
  
  // Multi-project watching: Map of project path -> FileFinder instance
  const watchedProjects = new Map<string, FileFinder>();

  function trackMethodUsage(code: string): void {
    METHOD_PATTERN.lastIndex = 0; // Reset regex state
    let match;
    while ((match = METHOD_PATTERN.exec(code)) !== null) {
      const [, adapterName, methodName] = match;
      if (adapterNamesCache.has(adapterName)) {
        const key = `${adapterName}.${methodName}`;
        methodUsage.set(key, (methodUsage.get(key) || 0) + 1);
        // Persist to FFF frecency DB for cross-session tracking
        if (fileFinder) {
          try { fileFinder.trackQuery(key); } catch { /* ignore */ }
        }
        // Evict least-used entry if over cap
        if (methodUsage.size > METHOD_USAGE_CAP) {
          let minKey = '', minVal = Infinity;
          for (const [k, v] of methodUsage) { if (v < minVal) { minKey = k; minVal = v; } }
          if (minKey) methodUsage.delete(minKey);
        }
      }
    }
  }

  function getMethodFrecency(adapterName: string, methodName: string): number {
    return methodUsage.get(`${adapterName}.${methodName}`) || 0;
  }

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
  const backgroundTasks = new Map<string, BackgroundTask>();
  let taskIdCounter = 0;
  const MAX_BACKGROUND_TASKS = 20;

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
      task.logs = result.logs || [];

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

  // Tool: mcx_execute
  server.registerTool(
    "mcx_execute",
    {
      title: "Execute Code or Shell in MCX Sandbox",
      description: `Execute JavaScript/TypeScript code OR shell commands.

## Mode 1: Code Execution (code parameter)
NOT for file/content search - use mcx_find (files) or mcx_grep (content) instead.

### Calling Adapters
Adapters are available as globals. Use camelCase for names with hyphens:
- supabase.list_projects()
- chromeDevtools.listPages()  // chrome-devtools → chromeDevtools
- adapters['chrome-devtools'].listPages()  // bracket notation also works

### Available Adapters
${typeSummary}

Use mcx_search({ adapter: "name" }) for method details.

### Built-in Helpers
- pick(arr, ['id', 'name']) - Extract fields
- first(arr, 5) - First N items
- count(arr, 'field') - Count by field
- sum(arr, 'field') - Sum numeric field

### Variables
- Results auto-stored as $result
- storeAs: "name" → $name
- $clear: Clear all
- delete $varname: Delete specific variable

## Mode 2: Shell Execution (shell parameter)
Run system commands with proper timeout and output capture.

Examples:
- { shell: "npm test" }
- { shell: "git status", truncate: false }
- { shell: "docker ps -a", storeAs: "containers" }
- { shell: "make build", timeout: 120000 }

Returns: { exitCode, stdout, stderr, duration, command }

## Large Output Handling
- intent: Auto-index output >5KB and search. Returns snippets instead of full data.

## Think in Code: Filter Before Returning
❌ BAD: api.getUsers() → returns 500 users, 50KB of data
✅ GOOD: api.getUsers().filter(u => u.active).map(u => ({ id: u.id, name: u.name }))

❌ BAD: api.getOrders() → returns full order objects
✅ GOOD: count(api.getOrders(), 'status') → { pending: 5, shipped: 12 }

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

        // Shell execution mode
        if (params.shell) {
          const cmd = params.shell.trim();
          const timeout = params.timeout ?? 30000;
          
          try {
            const startTime = performance.now();
            const safeEnv = getSafeEnv();
            
            const proc = Bun.spawn([SHELL_PATH, '-c', cmd], {
              cwd: process.cwd(),
              env: { ...safeEnv, ...(config?.env || {}) },
              stdout: 'pipe',
              stderr: 'pipe',
            });

            // Race between process completion and timeout
            const timeoutPromise = new Promise<'timeout'>((resolve) => 
              setTimeout(() => resolve('timeout'), timeout)
            );
            const exitPromise = proc.exited.then(code => ({ code }));
            
            const raceResult = await Promise.race([exitPromise, timeoutPromise]);
            
            if (raceResult === 'timeout') {
              killTree(proc);
              return {
                content: [{ type: "text" as const, text: `Shell command timed out after ${timeout}ms` }],
                isError: true,
              };
            }

            const exitCode = raceResult.code;
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            
            // Hard cap check to prevent OOM
            const totalBytes = stdout.length + stderr.length;
            if (totalBytes > HARD_CAP_BYTES) {
              return {
                content: [{ type: "text" as const, text: `Output exceeded 100MB limit (${Math.round(totalBytes / 1024 / 1024)}MB). Use filters or pagination.` }],
                isError: true,
              };
            }
            
            const duration = Math.round(performance.now() - startTime);

            // Store result for subsequent queries
            const shellResult = {
              exitCode,
              stdout: stdout.trim(),
              stderr: stderr.trim(),
              duration,
              command: cmd,
            };
            state.set('result', shellResult);
            if (params.storeAs && params.storeAs !== 'result') {
              state.set(params.storeAs, shellResult);
            }

            // Smart output formatting
            const outputParts: string[] = [];
            
            // Success/failure header
            if (exitCode === 0) {
              outputParts.push(`✓ Completed in ${duration}ms`);
            } else {
              outputParts.push(`✗ Exit code ${exitCode} (${duration}ms)`);
            }

            // Apply truncation if enabled
            let finalStdout = stdout.trim();
            let finalStderr = stderr.trim();
            
            if (params.truncate) {
              const maxLen = params.maxStringLength ?? 500;
              if (finalStdout.length > maxLen) {
                finalStdout = finalStdout.slice(0, maxLen) + `\n... (${finalStdout.length - maxLen} chars truncated)`;
              }
              if (finalStderr.length > maxLen) {
                finalStderr = finalStderr.slice(0, maxLen) + `\n... (${finalStderr.length - maxLen} chars truncated)`;
              }
            }

            // Add output sections
            if (finalStdout) {
              outputParts.push('');
              outputParts.push(finalStdout);
            }
            if (finalStderr) {
              outputParts.push('');
              outputParts.push(`stderr:\n${finalStderr}`);
            }
            if (!finalStdout && !finalStderr) {
              outputParts.push('(no output)');
            }

            // Intent auto-index for large outputs
            if (params.intent && totalBytes > INTENT_THRESHOLD) {
              const store = getContentStore();
              const sourceLabel = params.storeAs || `shell:${cmd.slice(0, 30)}`;
              const content = stdout + (stderr ? `\n\n--- stderr ---\n${stderr}` : '');
              const sourceId = store.index(content, sourceLabel, { contentType: 'plaintext' });
              const searchResults = searchWithFallback(store, params.intent, { limit: 5, sourceId });
              
              outputParts.push('');
              outputParts.push(`Indexed as "${sourceLabel}". Search results for "${params.intent}":`);
              searchResults.forEach(r => outputParts.push(`- ${r.title}: ${extractSnippet(r.snippet, params.intent, 200)}`));
            } else if (!params.intent && totalBytes > AUTO_INDEX_THRESHOLD) {
              // Auto-index híbrido: large outputs (>50KB) auto-indexed even without intent
              try {
                const store = getContentStore();
                const sourceLabel = params.storeAs || `shell:${cmd.slice(0, 30)}`;
                const content = stdout + (stderr ? `\n\n--- stderr ---\n${stderr}` : '');
                store.index(content, sourceLabel, { contentType: 'plaintext' });
                outputParts.push('');
                outputParts.push(`📦 Auto-indexed as "${sourceLabel}" (${Math.round(totalBytes/1024)}KB). Use mcx_search to query.`);
              } catch {
                // Indexing failed silently
              }
            }

            trackToolUsage('mcx_execute');
            
            return {
              content: [{ type: "text" as const, text: outputParts.join('\n') + suggestNextTool("mcx_execute") }],
              toolResult: outputParts.join('\n'),
              structuredContent: shellResult,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `Shell error: ${message}` }],
              isError: true,
            };
          }
        }

        // Code execution mode
        const code = params.code?.trim() || '';

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

        // Auto-recovery: detect file helper patterns with undefined variables
        // and auto-load matching files before execution
        if (fileFinder) {
          const helperPattern = /(?:grep|lines|around|block|outline)\(\$(\w+)/g;
          const varMatches = [...code.matchAll(helperPattern)];
          const autoLoaded: string[] = [];
          
          for (const [, varName] of varMatches) {
            // Skip if variable already exists or is a built-in
            if (state.has(varName) || varName === 'file' || varName === 'result') continue;
            
            // Try to find a file with EXACT basename match only
            // This prevents loading wrong files when FFF is in global directory
            const searchResult = fileFinder.fileSearch(varName, { pageSize: 10 });
            if (searchResult.ok && searchResult.value.items.length > 0) {
              // ONLY use exact basename match - never fall back to fuzzy match
              const exactMatch = searchResult.value.items.find(f => {
                const base = f.relativePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') || '';
                return base.toLowerCase() === varName.toLowerCase();
              });
              // Skip if no exact match found
              if (!exactMatch) continue;
              const file = exactMatch;
              try {
                const content = await Bun.file(file.path).text();
                const fileLines = content.split('\n');
                // Store as file object with helpers-compatible format
                state.set(varName, {
                  text: fileLines.map((l, i) => `${i + 1}: ${l}`).join('\n'),
                  lines: fileLines.map((l, i) => `${i + 1}: ${l}`),
                  path: file.path,
                  size: content.length,
                });
                autoLoaded.push(`$${varName} → ${file.relativePath}`);
              } catch {
                // Ignore load errors, let execution fail naturally
              }
            }
          }
          
          // Add auto-load info to result logs if any were loaded
          if (autoLoaded.length > 0) {
            // Will be visible in warnings/logs
            console.error(pc.dim(`[MCX] Auto-loaded: ${autoLoaded.join(', ')}`));
          }
        }

        // Pattern D: Check for retry loop before executing
        const codeSig = getCodeSignature(code);
        const prevFailure = executeFailures.get(codeSig);
        const isRetry = prevFailure && (Date.now() - prevFailure.lastTime) < 60000;
        let retryWarning = '';
        if (isRetry && prevFailure.count >= 2) {
          retryWarning = `\n⚠️ This code failed ${prevFailure.count}x recently. Last error: ${prevFailure.lastError.slice(0, 100)}`;
        }

        // Execute code in sandbox
        const result = await sandbox.execute(FILE_HELPERS_CODE + code, {
          adapters: adapterContext,
          variables: state.getAllPrefixed(),
          env: config?.env || {},
        });

        // Track I/O bytes from sandbox (FS reads + network)
        trackSandboxIO(result.tracking);

        if (!result.success) {
          const errorMsg = result.error
            ? `${result.error.name}: ${result.error.message}`
            : "Unknown error";
          const truncatedLogs = truncateLogs(result.logs);
          const logsSection = truncatedLogs.length > 0 ? `\n\nLogs:\n${truncatedLogs.join("\n")}` : "";

          // Auto-fetch error context using FFF if available
          let contextSection = "";
          if (fileFinder && result.error?.stack) {
            // Parse stack for file:line patterns (e.g., "at file.ts:42:10")
            const fileLinePattern = /at\s+(?:[^\s]+\s+)?\(?([^:]+):(\d+)(?::\d+)?\)?/g;
            const matches = [...result.error.stack.matchAll(fileLinePattern)];
            const seen = new Set<string>();

            for (const match of matches.slice(0, 2)) { // Limit to 2 locations
              const [, filePath, lineStr] = match;
              const lineNum = parseInt(lineStr, 10);
              const key = `${filePath}:${lineNum}`;
              if (seen.has(key) || isExcludedPath(filePath)) continue;
              seen.add(key);

              // Try to find file and show context (read max 100KB for efficiency)
              try {
                const searchResult = fileFinder.fileSearch(filePath, { pageSize: 1 });
                if (searchResult.ok && searchResult.value.items.length > 0) {
                  const file = searchResult.value.items[0];
                  const bunFile = Bun.file(file.path);
                  const size = bunFile.size;
                  // Read only first 100KB - enough for most source files
                  const maxRead = Math.min(size, 100 * 1024);
                  const content = await bunFile.slice(0, maxRead).text();
                  const lines = content.split('\n');
                  // Skip if target line is beyond what we read
                  if (lineNum <= lines.length) {
                    const start = Math.max(0, lineNum - 3);
                    const end = Math.min(lines.length, lineNum + 2);
                    const snippet = lines.slice(start, end)
                      .map((l, i) => `${start + i + 1}${start + i + 1 === lineNum ? '>' : ' '} ${l}`)
                      .join('\n');
                    contextSection += `\n\n## Context: ${file.relativePath}:${lineNum}\n\`\`\`\n${snippet}\n\`\`\``;
                  }
                }
              } catch {
                // Ignore context fetch errors
              }
            }
          }

          // Pattern D: Track failure for retry loop detection
          const failureRecord = executeFailures.get(codeSig) || { count: 0, lastTime: 0, lastError: '' };
          failureRecord.count++;
          failureRecord.lastTime = Date.now();
          failureRecord.lastError = errorMsg;
          executeFailures.set(codeSig, failureRecord);

          return {
            content: [{ type: "text" as const, text: `Execution error: ${errorMsg}${retryWarning}${logsSection}${contextSection}` }],
            isError: true,
          };
        }

        // Clear failure record on success
        executeFailures.delete(codeSig);

        // Track method usage for frecency ranking in mcx_search
        trackMethodUsage(params.code);

        // Extract native images before summarization
        const { value: valueWithoutImages, images } = extractImages(result.value);

        // Auto-store in $result + custom name if specified
        state.set('result', result.value);
        if (params.storeAs && params.storeAs !== 'result') {
          state.set(params.storeAs, result.value);
        }

        // Auto-compress stale variables to save context (5 min old, >1KB)
        const compressed = state.compressStale(5 * 60 * 1000, 1000);
        if (compressed.length > 0) {
          result.logs.push(`[INFO] Auto-compressed stale variables: ${compressed.join(', ')}`);
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
                ...searchResults.map(r => `- ${r.title}: ${extractSnippet(r.snippet, params.intent, 200)}`),
                '',
                `Distinctive terms: ${terms.slice(0, 15).join(', ')}`,
                '',
                'Use mcx_search to query this indexed content.',
              ].filter(Boolean).join('\n');

              return {
                content: [{ type: "text" as const, text: indexedOutput }, ...images],
                toolResult: indexedOutput,
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

        // Auto-index híbrido: large outputs (>50KB) auto-indexed even without intent
        // This gives both $result (code access) + FTS5 (search access)
        const serialized = safeStringify(valueWithoutImages);
        let autoIndexedLabel: string | null = null;
        if (!params.intent && serialized.length > AUTO_INDEX_THRESHOLD) {
          try {
            const store = getContentStore();
            autoIndexedLabel = generateExecutionLabel(params.storeAs);
            store.index(serialized, autoIndexedLabel, { contentType: 'plaintext' });
          } catch {
            autoIndexedLabel = null;
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
          autoIndexedLabel ? `📦 Auto-indexed as "${autoIndexedLabel}" (${Math.round(serialized.length/1024)}KB). Use mcx_search to query.` : "",
          truncatedLogs.length > 0 ? `Logs:\n${truncatedLogs.join("\n")}` : "",
          summarized.truncated
            ? `Result (${summarized.originalSize}):\n${formatToolResult(summarized.value)}`
            : valueWithoutImages !== undefined && valueWithoutImages !== null
              ? `Result:\n${formatToolResult(summarized.value)}`
              : images.length > 0
                ? "Image(s) attached"
                : "Code executed successfully",
        ].filter(Boolean).join("\n\n");

        // Enforce character limit as safety net
        const { text: textOutput, truncated: charLimitTruncated } = enforceCharacterLimit(rawTextOutput);

        // Build content array with text first, then images
        const content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> = [
          { type: "text" as const, text: textOutput + suggestNextTool("mcx_execute") },
          ...images,
        ];

        // Track for workflow detection (Pattern H: edit→build→edit cycle)
        trackToolUsage('mcx_execute');

        // Detect raw/unfiltered data and warn (use original value, not truncated)
        const rawDataWarning = detectRawData(valueWithoutImages, serialized.length);

        // Claude Code only shows structuredContent to user (ignores content)
        // This is a client limitation, not MCP spec behavior
        // Format result as readable string - best we can do
        const autoIndexMsg = autoIndexedLabel 
          ? `📦 Auto-indexed as "${autoIndexedLabel}" (${Math.round(serialized.length/1024)}KB). Use mcx_search to query.\n\n`
          : '';
        const warningMsg = rawDataWarning ? rawDataWarning + '\n\n' : '';
        return { 
          content,
          toolResult: warningMsg + autoIndexMsg + formatToolResult(summarized.value),
          _rawBytes: summarized.rawBytes 
        };
      } catch (error) {
        logger.error("mcx_execute sandbox error", error);
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

        // Format skill result for readable output
        const rawText = summarized.value !== undefined ? formatToolResult(summarized.value) : "Skill executed successfully";
        const { text: finalText, truncated: charLimitTruncated } = enforceCharacterLimit(rawText);

        // Minimal structuredContent - only metadata
        const structured: Record<string, unknown> = {};
        if (summarized.truncated || charLimitTruncated) structured.truncated = true;
        const hasStructured = Object.keys(structured).length > 0;

        return {
          content: [{ type: "text" as const, text: finalText }],
          ...(hasStructured ? { structuredContent: structured } : {}),
          _rawBytes: summarized.rawBytes,
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
        toolResult: summary,
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
FTS5 search on ALL indexed content (from mcx_execute, mcx_fetch, mcx_file).
- mcx_search({ queries: ["error", "timeout"] })
- mcx_search({ queries: ["bun", "configuration"] }) // searches fetched URLs too

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

      // Clear mode: wipe FTS5 index
      if (params.clear) {
        const store = getContentStore();
        const sources = store.getSources();
        const count = sources.length;
        store.clear();
        return {
          content: [{ type: "text" as const, text: `Cleared ${count} indexed sources.` }],
          toolResult: `Cleared ${count} indexed sources.`,
        };
      }

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
              toolResult: summary,
              structuredContent: { mode: 'spec', storedAs: params.storeAs, itemCount: Array.isArray(result) ? result.length : 1 },
            };
          }

          // Auto-store in $search (no storeAs since early return handles that case)
          const state = getSandboxState();
          state.set('search', result);

          const output = formatToolResult(result);
          const { text, truncated } = enforceCharacterLimit(output);

          // Minimal structuredContent
          const structured: Record<string, unknown> = { mode: 'spec', storedAs: ['search'] };
          if (truncated) structured.truncated = true;

          return {
            content: [{ type: "text" as const, text }],
            toolResult: text,
            ...(Object.keys(structured).length > 0 ? { structuredContent: structured } : {}),
          };
        } catch (error) {
          logger.error("mcx_search spec query error", error);
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

          const queryStr = params.queries.join(' ');
          const rawOutput = [
            `Found ${allResults.length} results for: ${params.queries.join(', ')}`,
            params.source ? `Source: ${params.source}` : `Searching ${sources.length} sources`,
            '',
            ...allResults.slice(0, 5).map(r => `## ${r.title} (${r.sourceLabel})\n${extractSnippet(r.snippet, queryStr, 250)}`),
            allResults.length > 5 ? `\n... +${allResults.length - 5} more in $search.results` : '',
          ].join('\n');

          const { text: output, truncated } = enforceCharacterLimit(rawOutput);

          return {
            content: [{ type: "text" as const, text: output }],
            toolResult: output,
            structuredContent: { mode: 'content', storedAs: ['search'], results: allResults.length, truncated },
          };
        } catch (error) {
          logger.error("mcx_search content search error", error);
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

      // Sort methods by frecency (most used first)
      if (results.methods.length > 1) {
        results.methods.sort((a, b) => {
          const freqA = getMethodFrecency(a.adapter, a.method);
          const freqB = getMethodFrecency(b.adapter, b.method);
          return freqB - freqA; // Higher frequency first
        });
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
        const msg = `No results found for ${filterDesc}`;
        return {
          content: [{ type: "text" as const, text: msg }],
          toolResult: msg,
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
        const summary = `Stored ${results.methods.length} methods, ${results.adapters.length} adapters as ${storedVars}\nExplore: $search.methods[0].parameters` + suggestNextTool("mcx_search");
        return {
          content: [{ type: "text" as const, text: summary }],
          toolResult: summary,
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
      const { text: finalText } = enforceCharacterLimit(output.join("\n") + suggestNextTool("mcx_search"));

      return {
        content: [{ type: "text" as const, text: finalText }],
        toolResult: finalText,
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
      description: `Run shell commands, code operations, and searches in one call. Bypasses throttling.

## Shell Commands
mcx_batch({ commands: [
  { label: "Git Status", command: "git status" },
  { label: "Tests", command: "npm test" }
]})

## Code Operations  
mcx_batch({ operations: [{ code: "alegra.getInvoices()", storeAs: "inv" }] })

## FTS5 Searches
mcx_batch({ queries: ["error", "timeout"] })

Output is auto-indexed with markdown headings (# label) for chunking.`,
      inputSchema: BatchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: BatchInput) => {
      // Support 'operations' as alias for 'executions'
      const operations = params.operations || params.executions;
      const timeout = params.timeout ?? 30000;
      
      const output: string[] = [];
      const results: {
        commands: Array<{ label: string; success: boolean; exitCode?: number; error?: string }>;
        executions: Array<{ storeAs?: string; success: boolean; error?: string }>;
        searches: Array<{ query: string; count: number }>;
      } = { commands: [], executions: [], searches: [] };
      
      // Track sourceIds for scoped queries
      const batchSourceIds: number[] = [];

      // Run shell commands first
      if (params.commands && params.commands.length > 0) {
        const safeEnv = getSafeEnv();

        for (const cmd of params.commands) {
          output.push(`# ${cmd.label}`);
          output.push('');
          
          try {
            const proc = Bun.spawn([SHELL_PATH, '-c', cmd.command], {
              cwd: process.cwd(),
              env: { ...safeEnv, ...(config?.env || {}) },
              stdout: 'pipe',
              stderr: 'pipe',
            });

            // Race with timeout
            const timeoutPromise = new Promise<'timeout'>((resolve) => 
              setTimeout(() => resolve('timeout'), timeout)
            );
            const exitPromise = proc.exited.then(code => ({ code }));
            const raceResult = await Promise.race([exitPromise, timeoutPromise]);

            if (raceResult === 'timeout') {
              killTree(proc);
              output.push(`[TIMEOUT after ${timeout}ms]`);
              output.push('');
              results.commands.push({ label: cmd.label, success: false, error: 'timeout' });
              continue;
            }

            const exitCode = raceResult.code;
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();

            // Hard cap check
            if (stdout.length + stderr.length > HARD_CAP_BYTES) {
              output.push(`[OUTPUT EXCEEDED 100MB LIMIT]`);
              output.push('');
              results.commands.push({ label: cmd.label, success: false, error: 'output exceeded 100MB' });
              continue;
            }

            if (stdout.trim()) {
              output.push(stdout.trim());
            }
            if (stderr.trim()) {
              output.push(`stderr: ${stderr.trim()}`);
            }
            if (!stdout.trim() && !stderr.trim()) {
              output.push('(no output)');
            }
            output.push('');

            results.commands.push({ 
              label: cmd.label, 
              success: exitCode === 0, 
              exitCode,
              error: exitCode !== 0 ? `exit code ${exitCode}` : undefined
            });
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            output.push(`[ERROR: ${errorMsg}]`);
            output.push('');
            results.commands.push({ label: cmd.label, success: false, error: errorMsg });
          }
        }
      }

      // Run operations sequentially
      if (operations && operations.length > 0) {
        output.push("## Operations");
        output.push("");

        // Hoist singletons outside loop
        const state = getSandboxState();
        const store = getContentStore();

        for (const exec of operations) {
          try {
            // Get stored variables fresh each iteration (state mutates via storeAs)
            const result = await sandbox.execute(FILE_HELPERS_CODE + exec.code, {
              adapters: adapterContext,
              variables: state.getAllPrefixed(),
              env: config?.env || {},
            });
            trackSandboxIO(result.tracking);

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
                  const sourceId = store.index(serialized, sourceLabel, { contentType: 'plaintext' });
                  batchSourceIds.push(sourceId);
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
            logger.error("mcx_batch execution error", error);
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
          // Determine search scope:
          // 1. User-specified source takes priority
          // 2. Otherwise, scope to batch-created sources if any
          // 3. Otherwise, search all indexed content
          let sourceId: number | undefined;
          let sourceIds: number[] | undefined;
          
          if (params.source) {
            const sourceLabel = params.source;
            const source = sources.find(s => s.label === sourceLabel || s.label.includes(sourceLabel));
            sourceId = source?.id;
          } else if (batchSourceIds.length > 0) {
            sourceIds = batchSourceIds;
          }

          try {
            const batchResults = batchSearch(store, params.queries, { limit: 5, sourceId, sourceIds });
            for (const [query, searchResults] of Object.entries(batchResults)) {
              output.push(`### "${query}" (${searchResults.length} results)`);
              for (const r of searchResults) {
                output.push(`- ${r.title}: ${extractSnippet(r.snippet, query, 150)}`);
              }
              output.push("");
              results.searches.push({ query, count: searchResults.length });
            }
          } catch (error) {
            logger.error("mcx_batch search error", error);
            output.push(`Search error: ${error instanceof Error ? error.message : error}`);
            for (const query of params.queries) {
              results.searches.push({ query, count: 0 });
            }
          }
        }
      }

      // Auto-index combined output if substantial
      const combinedOutput = output.join('\n');
      if (combinedOutput.length > INTENT_THRESHOLD) {
        try {
          const store = getContentStore();
          store.index(combinedOutput, 'batch', { contentType: 'markdown' });
        } catch {
          // Indexing failed, continue
        }
      }

      // Store in $batch
      const state = getSandboxState();
      state.set('batch', results);

      // Compact summary
      const cmdCount = results.commands.length;
      const execCount = results.executions.length;
      const searchCount = results.searches.length;
      
      const parts: string[] = [];
      if (cmdCount > 0) parts.push(`${cmdCount} commands`);
      if (execCount > 0) parts.push(`${execCount} operations`);
      if (searchCount > 0) parts.push(`${searchCount} searches`);
      
      const summary = [
        `Batch complete: ${parts.join(', ') || 'nothing to run'}`,
        combinedOutput.length > INTENT_THRESHOLD 
          ? `Indexed ${combinedOutput.length} chars. Use mcx_search to query.`
          : '',
        `Stored as $batch. Access: $batch.commands, $batch.executions, $batch.searches`,
      ].filter(Boolean).join('\n');

      return {
        content: [{ type: "text" as const, text: summary }],
        toolResult: summary,
        structuredContent: {
          storedAs: ['batch'],
          counts: { commands: cmdCount, executions: execCount, searches: searchCount },
        },
      };
    }
  );

  // Tool: mcx_file

  const FileInputSchema = z.object({
    path: z.string().describe("File path to process"),
    code: z.string().optional().describe("Code to process file (JS default, or shell/python with language param)"),
    language: z.enum(["js", "shell", "python"]).optional().default("js").describe("Execution language: js (default), shell, python"),
    intent: z.string().optional().describe("Auto-index if output > 5KB"),
    storeAs: z.string().optional().describe("Store file as variable (without code: stores file content, not result)"),
  });
  type FileInput = z.infer<typeof FileInputSchema>;

  server.registerTool(
    "mcx_file",
    {
      title: "Process File",
      description: `Process file with code. Supports JavaScript (default), shell, and Python.

Supports fuzzy paths - partial names are resolved via FFF:
- mcx_file({ path: "serve", code: "..." }) → serve.ts

## JavaScript (default)
File content available as $file.
- mcx_file({ path: "data.json", code: "$file.items.length" })
- mcx_file({ path: "config.yaml", code: "$file.lines.filter(l => l.includes('port'))" })

$file shape:
- JSON files: parsed object with __raw for line access
- Other files: { text, lines } (lines are numbered: "1: content")

## Shell
File path available as $FILE_PATH.
- mcx_file({ path: "package.json", language: "shell", code: "jq '.dependencies | keys' $FILE_PATH" })
- mcx_file({ path: "data.csv", language: "shell", code: "wc -l $FILE_PATH" })

## Python
File path available as FILE_PATH variable.
- mcx_file({ path: "data.csv", language: "python", code: "import pandas as pd; df = pd.read_csv(FILE_PATH); print(df.describe())" })

**Tips:**
- Use \`storeAs\` for large files: \`mcx_file({ path, storeAs: "src" })\` → query with helpers
- Helpers (JS only, use after storeAs): around(), lines(), grep(), block(), outline()
- For edits: find line numbers with grep(), then use mcx_edit line mode`,
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
        let resolvedPath = params.path;
        let content: string;

        // Try direct read first, then fuzzy search if not found
        try {
          content = await readFile(resolvedPath, 'utf-8');
        } catch (err: unknown) {
          const isNotFound = err instanceof Error && 'code' in err && err.code === 'ENOENT';
          if (!isNotFound || !fileFinder) {
            throw err;
          }

          // Fuzzy search for file
          const searchResult = fileFinder.fileSearch(params.path, { pageSize: 3 });
          if (!searchResult.ok || searchResult.value.items.length === 0) {
            throw new Error(`File not found: ${params.path}`);
          }

          const matches = searchResult.value.items;
          const scores = searchResult.value.scores;
          // Auto-resolve if single match, high absolute score (>0.8), or 2x better than second
          if (matches.length === 1 || scores[0].total > 0.8 || (matches.length > 1 && scores[0].total > scores[1].total * 2)) {
            // Single match or clear winner - use it
            resolvedPath = matches[0].path;
            content = await readFile(resolvedPath, 'utf-8');
          } else {
            // Filter suggestions to only those within 50% of top score
            const topScore = scores[0].total;
            const relevantMatches = matches.filter((_, i) => scores[i].total >= topScore * 0.5);
            const suggestions = relevantMatches.slice(0, 3).map(m => `  - ${m.relativePath}`).join('\n');
            return {
              content: [{ type: "text" as const, text: `Multiple matches for "${params.path}":\n${suggestions}\n\nSpecify full path or be more specific.` }],
              isError: true,
            };
          }
        }

        const ext = extname(resolvedPath).toLowerCase();

        // Parse based on extension
        let $file: unknown;
        const rawLines = content.split('\n');
        const numberedLines = rawLines.map((l, i) => `${i + 1}: ${l}`);
        const __raw = { text: numberedLines.join('\n'), lines: numberedLines };

        if (ext === '.json') {
          try {
            const parsed = JSON.parse(content);
            // Add __raw for line-based access (editing, grep)
            $file = { ...parsed, __raw };
          } catch {
            // JSON parse failed, treat as text with numbered lines
            $file = __raw;
          }
        } else {
          // Text file with numbered lines (Optimization #1)
          $file = __raw;
        }

        // Update proximity context for reranking
        updateProximityContext(resolvedPath);

        // Workflow tracking and inefficiency detection (Optimization #5)
        const inefficiencyWarning = detectInefficiency('mcx_file', resolvedPath);
        trackToolUsage('mcx_file', resolvedPath);

        // Track file access count (Pattern A: auto-index frequently accessed files)
        const now = Date.now();
        const accessLog = fileAccessLog.get(resolvedPath);
        if (accessLog && (now - accessLog.firstAccess) < THROTTLE_WINDOW_MS) {
          accessLog.count++;
        } else {
          fileAccessLog.set(resolvedPath, { count: 1, firstAccess: now });
        }
        const accessCount = fileAccessLog.get(resolvedPath)!.count;

        // Auto-index file content for later search (sync, like context-mode)
        // Index if: large file (>10KB) OR frequently accessed (3+ times)
        const shouldAutoIndex = content.length > FILE_INDEX_THRESHOLD || accessCount >= 3;
        if (shouldAutoIndex) {
          const store = getContentStore();
          const fileLabel = basename(resolvedPath);
          const indexContent = isHtml(content) ? htmlToMarkdown(content) : content;
          store.index(indexContent, fileLabel, { contentType: ext === '.md' ? 'markdown' : 'plaintext' });
        }

        // Store-only mode: save file content without executing code (keeps content out of context)
        if (params.storeAs && !params.code) {
          const state = getSandboxState();
          
          // Track storeAs timestamp for stale line number detection
          fileStoreTime.set(resolvedPath, Date.now());

          // For JSON: store parsed object with __raw for line access
          // For text: store { text, lines } structure
          // Check if JSON actually parsed (has __raw), not just extension
          const isValidJson = typeof $file === 'object' && $file !== null && '__raw' in $file;
          let storedValue: unknown;
          let storeAsOutput: string;

          if (isValidJson) {
            // Store parsed JSON with __raw (same as $file in code mode)
            state.set(params.storeAs, $file);
            storedValue = $file;
            storeAsOutput = `Stored as ${params.storeAs} (JSON object with ${__raw.lines.length} lines)
JSON helpers: keys($${params.storeAs}), values($${params.storeAs}), pick($${params.storeAs}, ['key1']), paths($${params.storeAs})
Line helpers: $${params.storeAs}.__raw.lines, grep($${params.storeAs}.__raw, 'pattern')
Tip: Access properties directly: $${params.storeAs}.name, $${params.storeAs}.version`;
          } else {
            // Store text with numbered lines (Optimization #1)
            state.set(params.storeAs, __raw);
            storedValue = __raw;
            storeAsOutput = `Stored as ${params.storeAs} (${__raw.lines.length} lines, ${content.length} chars)
Helpers: around($${params.storeAs}, line, ctx), lines($${params.storeAs}, start, end), head($${params.storeAs}, n), tail($${params.storeAs}, n), grep($${params.storeAs}, pattern), grepContext($${params.storeAs}, pattern, ctx), block($${params.storeAs}, line), outline($${params.storeAs})
Tip: Use mcx_execute({ code: "...", truncate: false }) for full output`;
          }

          const finalOutput = inefficiencyWarning 
            ? `${inefficiencyWarning}\n\n${storeAsOutput}`
            : storeAsOutput;

          return {
            content: [{ type: "text" as const, text: finalOutput }]
          };
        }

        // Auto-preview if no code/storeAs (show first 50 lines)
        if (!params.code) {
          // For JSON files that parsed, show formatted JSON preview
          if (ext === '.json' && typeof $file === 'object' && $file !== null && !('lines' in $file)) {
            const jsonPreview = JSON.stringify($file, null, 2).split('\n').slice(0, 50);
            const hasMore = JSON.stringify($file, null, 2).split('\n').length > 50;
            const preview = jsonPreview.join('\n') + (hasMore ? '\n... (truncated)' : '');
            const tip = `\n→ Use storeAs to load full file, or code to process`;
            const outputText = preview + tip;
            return {
              content: [{ type: "text" as const, text: outputText }],
              toolResult: outputText,
            };
          }
          // For text files with numbered lines
          const fileObj = $file as { lines?: string[] };
          if (fileObj.lines) {
            const previewLines = fileObj.lines.slice(0, 50);
            const hasMore = fileObj.lines.length > 50;
            const preview = previewLines.join('\n') + (hasMore ? `\n... +${fileObj.lines.length - 50} more lines` : '');
            const tip = `\n→ Use storeAs to load full file, or code to process`;
            const outputText = preview + tip;
            return {
              content: [{ type: "text" as const, text: outputText }],
              toolResult: outputText,
            };
          }
        }

        // Execute based on language
        const state = getSandboxState();
        const lang = params.language || 'js';
        
        let result: { success: boolean; value?: unknown; error?: { message: string } };
        
        if (lang === 'shell') {
          // Shell execution with $FILE_PATH (30s timeout)
          try {
            const safeEnv = getSafeEnv();
            
            const proc = Bun.spawn([SHELL_PATH, '-c', params.code!], {
              cwd: process.cwd(),
              env: { ...safeEnv, FILE_PATH: resolvedPath },
              stdout: 'pipe',
              stderr: 'pipe',
            });

            // Timeout race (30s default)
            const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30000));
            const exitPromise = proc.exited.then(code => ({ code }));
            const raceResult = await Promise.race([exitPromise, timeoutPromise]);

            if (raceResult === 'timeout') {
              killTree(proc);
              result = { success: false, error: { message: 'Shell command timed out after 30s' } };
            } else {
              const stdout = await new Response(proc.stdout).text();
              const stderr = await new Response(proc.stderr).text();
              const exitCode = raceResult.code;
              
              // Hard cap check
              if (stdout.length + stderr.length > HARD_CAP_BYTES) {
                result = { success: false, error: { message: 'Output exceeded 100MB limit. Use filters or pagination.' } };
              } else if (exitCode !== 0) {
                result = { success: false, error: { message: stderr || `Exit code ${exitCode}` } };
              } else {
                result = { success: true, value: stdout.trim() };
              }
            }
          } catch (err) {
            result = { success: false, error: { message: err instanceof Error ? err.message : String(err) } };
          }
        } else if (lang === 'python') {
          // Python execution with FILE_PATH variable (30s timeout)
          try {
            const safeEnv = getSafeEnv();
            const pythonCode = `FILE_PATH = ${JSON.stringify(resolvedPath)}\n${params.code}`;
            
            const proc = Bun.spawn(['python3', '-c', pythonCode], {
              cwd: process.cwd(),
              env: safeEnv,
              stdout: 'pipe',
              stderr: 'pipe',
            });

            // Timeout race (30s default)
            const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30000));
            const exitPromise = proc.exited.then(code => ({ code }));
            const raceResult = await Promise.race([exitPromise, timeoutPromise]);

            if (raceResult === 'timeout') {
              killTree(proc);
              result = { success: false, error: { message: 'Python command timed out after 30s' } };
            } else {
              const stdout = await new Response(proc.stdout).text();
              const stderr = await new Response(proc.stderr).text();
              const exitCode = raceResult.code;
              
              // Hard cap check
              if (stdout.length + stderr.length > HARD_CAP_BYTES) {
                result = { success: false, error: { message: 'Output exceeded 100MB limit. Use filters or pagination.' } };
              } else if (exitCode !== 0) {
                result = { success: false, error: { message: stderr || `Exit code ${exitCode}` } };
              } else {
                result = { success: true, value: stdout.trim() };
              }
            }
          } catch (err) {
            result = { success: false, error: { message: err instanceof Error ? err.message : String(err) } };
          }
        } else {
          // JavaScript execution with $file (default)
          const sandboxResult = await sandbox.execute(FILE_HELPERS_CODE + params.code, {
            adapters: adapterContext,
            variables: { ...state.getAllPrefixed(), $file },
            env: config?.env || {},
          });
          trackSandboxIO(sandboxResult.tracking);
          result = sandboxResult;
        }

        if (!result.success) {
          return {
            content: [{ type: "text" as const, text: `Error: ${result.error?.message || 'Execution failed'}` }],
            isError: true,
          };
        }

        const serialized = formatFileResult(result.value, params.code);

        // Warn if code returns entire file content (anti-pattern that fills context)
        if (FULL_FILE_CODE.has(params.code.trim()) && serialized.length > FULL_FILE_WARNING_BYTES) {
          const sizeKB = Math.round(serialized.length / 1024);
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Returning full file (${sizeKB}KB) fills context. Use store-only mode instead:\n\nmcx_file({ path: "${params.path}", storeAs: "src" })\n\nThen query with: around($src, line, ctx), grep($src, pattern), outline($src)`
            }],
            isError: true,
          };
        }

        // Store if requested
        if (params.storeAs) {
          state.set(params.storeAs, result.value);
        }

        // Intent auto-index for large outputs (aligned with mcx_execute pattern)
        if (params.intent && serialized.length > INTENT_THRESHOLD) {
          try {
            const store = getContentStore();
            const sourceLabel = generateExecutionLabel(params.storeAs || basename(resolvedPath));
            const sourceId = store.index(serialized, sourceLabel, { contentType: 'plaintext' });
            const chunks = store.getChunks(sourceId);
            const searchResults = searchWithFallback(store, params.intent, { limit: 5, sourceId });
            const terms = getDistinctiveTerms(chunks);

            const output = [
              `Indexed ${chunks.length} sections as "${sourceLabel}"`,
              formatStoredAs(params.storeAs),
              '',
              `Search results for "${params.intent}":`,
              ...searchResults.map(r => `- ${r.title}: ${extractSnippet(r.snippet, params.intent, 200)}`),
              '',
              `Distinctive terms: ${terms.slice(0, 15).join(', ')}`,
              '',
              'Use mcx_search to query this indexed content.',
            ].filter(Boolean).join('\n');

            return { content: [{ type: "text" as const, text: output }], toolResult: output };
          } catch {
            // Indexing failed, fall through to normal output
          }
        }

        const rawBytes = serialized.length;  // Track size before truncation
        const { text: finalText, truncated } = enforceCharacterLimit(serialized);
        const storedMsg = params.storeAs ? `\n${formatStoredAs(params.storeAs)}` : '';

        // For line arrays, return just text (Optimization #1 + #10)
        // For other types, include structuredContent for programmatic access
        const isLinesArray = Array.isArray(result.value) && result.value.every((r: unknown) => typeof r === 'string');

        if (isLinesArray) {
          // Use accessCount from earlier tracking (Pattern A)
          const callCount = accessCount;

          // Dynamic tip based on first line number + call count (Optimization #1.2 + #2+#3)
          const lineMatch = finalText.match(/^(\d+):/m);
          const line = lineMatch?.[1] || 'N';
          
          let dynamicTip: string;
          if (callCount === 1) {
            dynamicTip = `\n→ Helpers: around(${line}, 20), grep("pattern"), outline()`;
          } else if (callCount === 2) {
            dynamicTip = `\n→ Ready to edit? mcx_edit({ start: ${line} })`;
          } else {
            dynamicTip = `\n⚠️ Call #${callCount} to same file. Use around(${line}, 20) or mcx_edit directly.`;
          }

          const warningPrefix = inefficiencyWarning ? `${inefficiencyWarning}\n\n` : '';
          const outputText = warningPrefix + finalText + storedMsg + dynamicTip;
          return {
            content: [{ type: "text" as const, text: outputText }],
            toolResult: outputText,
            _rawBytes: rawBytes,
          };
        }

        const warningPrefix2 = inefficiencyWarning ? `${inefficiencyWarning}\n\n` : '';
        const finalOutput = warningPrefix2 + finalText + storedMsg;
        return {
          content: [{ type: "text" as const, text: finalOutput }],
          toolResult: finalOutput,
          structuredContent: {
            result: result.value,
            truncated,
            storeAs: params.storeAs,
          },
          _rawBytes: rawBytes,
        };
      } catch (error) {
        logger.error("mcx_file error", error);
        return {
          content: [{ type: "text" as const, text: `Error reading file: ${error instanceof Error ? error.message : error}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_edit (bypass native Edit's read requirement)
  const EditInputSchema = z.object({
    file_path: z.string().describe("Absolute path to the file to edit"),
    old_string: z.string().optional().describe("String mode: exact string to find and replace"),
    new_string: z.string().describe("The replacement string/content"),
    replace_all: z.boolean().optional().default(false).describe("String mode: replace all occurrences"),
    start: z.coerce.number().optional().describe("Line mode: start line (1-indexed)"),
    end: z.coerce.number().optional().describe("Line mode: end line (1-indexed, inclusive)"),
  });
  type EditInput = z.infer<typeof EditInputSchema>;

  server.registerTool(
    "mcx_edit",
    {
      title: "Edit File",
      description: `Edit a file. Two modes:

**Line mode** (PREFERRED - minimal tokens):
mcx_edit({ file_path, start: 10, end: 12, new_string: "new content" })
Only sends line numbers + new content. ~80% fewer tokens than string mode.

**String mode** (fallback when line numbers unknown):
mcx_edit({ file_path, old_string: "unique text", new_string: "replacement" })

**Why mcx_edit over native Edit?**
- Line mode: send 2 numbers instead of full old_string (massive token savings)
- No "must read first" requirement - edit directly if you know line numbers
- Stale line detection: warns if file changed since last storeAs

**Workflow:** mcx_file({ storeAs }) → grep/around to find lines → mcx_edit({ start, end })`,
      inputSchema: EditInputSchema,
    },
    async (params: EditInput): Promise<MCP.CallToolResult> => {
      try {
        const { file_path, old_string, new_string, replace_all, start, end } = params;

        let resolvedPath = file_path;
        if (!isAbsolute(file_path)) {
          resolvedPath = join(process.cwd(), file_path);
        }

        // Read file
        let content: string;
        try {
          content = await Bun.file(resolvedPath).text();
        } catch {
          return {
            content: [{ type: "text" as const, text: `Error: File not found or unreadable: ${resolvedPath}` }],
            isError: true,
          };
        }

        let newContent: string;
        let isAppend = false;
        let editStartLine = 1; // Track where edit starts for validation

        // Line mode: replace by line numbers (or append if start > lines.length)
        if (start !== undefined && end !== undefined) {
          // Check for stale line numbers (file was edited after storeAs)
          const storeTime = fileStoreTime.get(resolvedPath);
          const editTime = fileEditTime.get(resolvedPath);
          if (storeTime && editTime && editTime > storeTime) {
            return {
              content: [{
                type: "text" as const,
                text: `⚠️ File was edited since last storeAs. Line numbers may be stale.\n\n` +
                      `Re-read with: mcx_file({ path: "${basename(resolvedPath)}", storeAs: "..." })\n` +
                      `Or use string mode: mcx_edit({ old_string: "...", new_string: "..." })`
              }],
              isError: true,
            };
          }

          const lines = content.split('\n');
          // Allow append: start can be lines.length + 1
          if (start < 1 || start > lines.length + 1 || end < start) {
            return {
              content: [{ type: "text" as const, text: `Error: Invalid line range ${start}-${end} (file has ${lines.length} lines)` }],
              isError: true,
            };
          }
          // Append mode: start > lines.length
          isAppend = start > lines.length;
          const before = isAppend ? lines : lines.slice(0, start - 1);
          const after = isAppend ? [] : lines.slice(end);
          newContent = [...before, new_string, ...after].join('\n');
          editStartLine = start;
        }
        // String mode: find and replace
        else if (old_string) {
          // Detect truncated strings (from mcx_file output with "..." markers)
          // Pattern: word followed by ... at end, or ... followed by word (e.g., "params.int..." or "...content")
          const truncationPattern = /\w\.{3}$|\.{3}\w/;
          if (truncationPattern.test(old_string)) {
            return {
              content: [{
                type: "text" as const,
                text: `⚠️ old_string appears truncated (contains '...').\n\n` +
                      `This usually happens when copying from truncated mcx_file output.\n` +
                      `Use line mode instead: mcx_edit({ start: N, end: M, new_string: "..." })\n\n` +
                      `To get line numbers: mcx_file({ path: "...", code: "grep($var, 'pattern')" })`
              }],
              isError: true,
            };
          }
          
          // Simple approach: normalize everything to LF, do replacement, then restore CRLF if needed
          const hasCRLF = content.includes('\r\n');
          const contentLF = content.replace(/\r\n/g, '\n');
          const oldLF = old_string.replace(/\r\n/g, '\n');
          const newLF = new_string.replace(/\r\n/g, '\n');
          
          const firstIdx = contentLF.indexOf(oldLF);
          if (firstIdx === -1) {
            const searchPreview = oldLF.split('\n')[0].slice(0, 60);
            return {
              content: [{ type: "text" as const, text: `Error: old_string not found.\n\nSearching for: "${searchPreview}${oldLF.length > 60 ? '...' : ''}"\n\nTip: Use line mode (start/end) for complex edits.` }],
              isError: true,
            };
          }
          
          const hasMultiple = contentLF.indexOf(oldLF, firstIdx + oldLF.length) !== -1;
          if (hasMultiple && !replace_all) {
            // Find all occurrences and their line numbers
            const lines = contentLF.split('\n');
            const occurrences: number[] = [];
            let pos = 0;
            let lineNum = 1;
            for (const line of lines) {
              if (contentLF.slice(pos, pos + line.length + 1).includes(oldLF.split('\n')[0])) {
                // Check if this line starts an occurrence
                const checkStart = contentLF.indexOf(oldLF, pos);
                if (checkStart >= pos && checkStart <= pos + line.length) {
                  occurrences.push(lineNum);
                }
              }
              pos += line.length + 1;
              lineNum++;
            }
            const linesInfo = occurrences.length > 0 
              ? `\nFound at lines: ${occurrences.slice(0, 5).join(', ')}${occurrences.length > 5 ? ` (+${occurrences.length - 5} more)` : ''}`
              : '';
            return {
              content: [{ type: "text" as const, text: `Error: Multiple occurrences found.${linesInfo}\n\nUse replace_all: true or provide more context.` }],
              isError: true,
            };
          }
          
          // Do replacement in LF mode, then restore original line endings
          const resultLF = replace_all ? contentLF.replaceAll(oldLF, () => newLF) : contentLF.replace(oldLF, () => newLF);
          newContent = hasCRLF ? resultLF.replace(/\n/g, '\r\n') : resultLF;
          // Calculate edit start line from character index
          editStartLine = contentLF.slice(0, firstIdx).split('\n').length;
        }
        else {
          return {
            content: [{ type: "text" as const, text: `Error: Provide old_string (string mode) or start+end (line mode)` }],
            isError: true,
          };
        }

        // Validate edit result BEFORE writing (catch broken code early)
        const ext = extname(resolvedPath).toLowerCase();
        if (['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs'].includes(ext)) {
          // Check brace balance
          const originalBalance = checkBraceBalance(content);
          const newBalance = checkBraceBalance(newContent);
          if (originalBalance === 0 && newBalance !== 0) {
            return {
              content: [{
                type: "text" as const,
                text: `⚠️ Edit would break brace balance (${newBalance > 0 ? '+' : ''}${newBalance} braces).\n\n` +
                      `Check your edit - likely missing or extra { or }.`
              }],
              isError: true,
            };
          }
          
          // Check for duplicate lines near edit (skip for append)
          if (!isAppend) {
            const duplicates = findDuplicatesNear(newContent, editStartLine);
            if (duplicates.length > 0) {
              return {
                content: [{
                  type: "text" as const,
                  text: `⚠️ Edit would create duplicate lines:\n` +
                        duplicates.slice(0, 3).map(d => `  "${d}"`).join('\n') +
                        `\n\nCheck your edit range and content.`
                }],
                isError: true,
              };
            }
          }
        }

        await Bun.write(resolvedPath, newContent);

        // Track edit timestamp for stale line number detection
        fileEditTime.set(resolvedPath, Date.now());

        // Pattern H: Check for edit→build→edit cycle BEFORE tracking (so current edit isn't in history yet)
        const patternHTip = detectInefficiency('mcx_edit', resolvedPath);

        // Workflow tracking (Optimization #5)
        trackToolUsage('mcx_edit', resolvedPath);

        // Build success message with appropriate tip
        const appendTip = isAppend ? ' (appended to end of file)' : '';
        const actionWord = isAppend ? 'Appended to' : 'Replaced in';

        if (patternHTip) {
          return {
            content: [{ type: "text" as const, text: `✓ ${actionWord} ${basename(resolvedPath)}${appendTip}\n${patternHTip}` }],
          };
        }

        // Pattern C: Tip after edit - suggest batching more changes
        const recentEdits = sessionWorkflow.lastTools.filter(t => t.tool === 'mcx_edit').length;
        const editTip = recentEdits >= 2 
          ? '\n💡 Multiple edits done. Batch remaining changes before build/test.'
          : '';

        return {
          content: [{ type: "text" as const, text: `✓ ${actionWord} ${basename(resolvedPath)}${appendTip}${editTip}` }],
        };
      } catch (error) {
        logger.error("mcx_edit error", error);
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_write (create/overwrite files, bypasses native Write's read requirement)
  const WriteInputSchema = z.object({
    file_path: z.string().describe("Absolute path to the file to create/overwrite"),
    content: z.string().describe("The content to write to the file"),
  });
  type WriteInput = z.infer<typeof WriteInputSchema>;

  server.registerTool(
    "mcx_write",
    {
      title: "Write File",
      description: `Create or overwrite a file. Bypasses native Write's "must read first" requirement.

Example:
mcx_write({ file_path: "/path/to/file.ts", content: "const x = 1;" })

Tip: For partial edits, use mcx_edit instead (preserves existing content).`,
      inputSchema: WriteInputSchema,
    },
    async (params: WriteInput): Promise<MCP.CallToolResult> => {
      try {
        const { file_path, content } = params;

        let resolvedPath = file_path;
        if (!isAbsolute(file_path)) {
          resolvedPath = join(process.cwd(), file_path);
        }

        await Bun.write(resolvedPath, content);

        // Track edit timestamp for stale line number detection
        fileEditTime.set(resolvedPath, Date.now());

        const lines = content.split('\n').length;
        return {
          content: [{ type: "text" as const, text: `✓ Wrote ${lines} lines to ${basename(resolvedPath)}` }],
        };
      } catch (error) {
        logger.error("mcx_write error", error);
        return {
          content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_fetch with TTL cache (capped to prevent unbounded growth)
  const URL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const URL_CACHE_MAX_SIZE = 100;
  const urlCache = new Map<string, { sourceId: number; indexedAt: number; label: string }>();

  const FetchInputSchema = z.object({
    url: z.string().describe("URL to fetch"),
    queries: coerceJsonArray(z.array(z.string())).optional().describe("Search after indexing"),
    force: z.boolean().optional().default(false).describe("Bypass cache and re-fetch"),
    preview: z.boolean().optional().default(false).describe("Return 3KB preview (full content still indexed)"),
  });
  type FetchInput = z.infer<typeof FetchInputSchema>;

  server.registerTool(
    "mcx_fetch",
    {
      title: "Fetch and Index URL",
      description: `Fetch URL, convert to markdown, index in FTS5, and optionally search.
Caches 24h - same URL returns cached results instantly.

WORKFLOW: Fetch once with queries to get relevant content immediately.
If queries don't match, use mcx_search with different terms on the cached content.

Examples:
- mcx_fetch({ url: "https://docs.example.com/guide", queries: ["authentication", "setup"] })
- mcx_fetch({ url: "https://api.example.com/openapi.json" }) // index only
- mcx_fetch({ url: "...", force: true }) // bypass 24h cache`,
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
        // Check cache first (unless force=true)
        const cached = urlCache.get(params.url);
        if (cached && !params.force) {
          const age = Date.now() - cached.indexedAt;
          if (age < URL_CACHE_TTL_MS) {
            const ageStr = age < 60000 ? `${Math.floor(age / 1000)}s` :
                           age < 3600000 ? `${Math.floor(age / 60000)}m` :
                           `${Math.floor(age / 3600000)}h`;
            const store = getContentStore();

            // Optional immediate search on cached content
            const output: string[] = [
              `Cached "${cached.label}" (${ageStr} ago)`,
              `Use force:true to re-fetch`,
            ];

            if (params.queries?.length) {
              output.push('');
              output.push('Search Results:');
              const safeQueries = params.queries.map(escapeFts5Query);
              const batchResults = batchSearch(store, safeQueries, { limit: 3, sourceId: cached.sourceId });
              const totalMatches = formatSearchResults(batchResults, output);
              if (totalMatches === 0) {
                output.push('');
                output.push('→ Try mcx_search({ queries: [...] }) with different terms');
              }
            }

            // Track cache hit
            const chunks = store.getChunks(cached.sourceId);
            const cachedSize = chunks.reduce((sum, c) => sum + c.content.length, 0);
            cacheHits++;
            cacheBytesSaved += cachedSize;

            const outputText = output.join('\n') + suggestNextTool("mcx_fetch");
            trackToolUsage('mcx_fetch');
          }
        }

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

        const httpContentType = response.headers.get('content-type') || '';
        let content: string;
        let label: string;
        let indexContentType: 'json' | 'markdown' | 'plaintext' = 'plaintext';

        try {
          label = new URL(params.url).hostname;
        } catch {
          label = 'fetched';
        }

        if (httpContentType.includes('json')) {
          const json = await response.json() as Record<string, unknown>;
          content = JSON.stringify(json, null, 2);
          indexContentType = 'json';  // Use JSON chunking
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
            indexContentType = 'markdown';
          }
        }

        // Track network bytes (request URL + content)
        trackNetworkBytes(content.length, params.url.length);

        // Index in FTS5
        const store = getContentStore();

        // Delete old source if re-fetching (force:true or expired cache)
        const oldCached = urlCache.get(params.url);
        if (oldCached) {
          try { store.deleteSource(oldCached.sourceId); } catch { /* ignore */ }
        }

        const sourceId = store.index(content, label, { contentType: indexContentType });
        const chunks = store.getChunkCount(sourceId);
        const terms = getDistinctiveTerms(store.getChunks(sourceId));

        // Update cache (evict oldest if full)
        if (urlCache.size >= URL_CACHE_MAX_SIZE) {
          const oldest = urlCache.keys().next().value;
          if (oldest) urlCache.delete(oldest);
        }
        urlCache.set(params.url, { sourceId, indexedAt: Date.now(), label });

        const output: string[] = [
          `Indexed "${label}": ${chunks} sections, ${content.length} chars`,
          `Terms: ${terms.slice(0, 20).join(', ')}`,
          `Use mcx_search({ queries: [...] }) to search this content.`,
        ];

        // Optional immediate search
        if (params.queries?.length) {
          output.push('');
          output.push('Search Results:');
          const safeQueries = params.queries.map(escapeFts5Query);
          const batchResults = batchSearch(store, safeQueries, { limit: 3, sourceId });
          const totalMatches = formatSearchResults(batchResults, output);
          if (totalMatches === 0) {
            output.push('');
            output.push('→ Try mcx_search({ queries: [...] }) with different terms');
          }
        }

        // Add preview if requested
        if (params.preview) {
          const PREVIEW_SIZE = 3000;
          const preview = content.length > PREVIEW_SIZE 
            ? content.slice(0, PREVIEW_SIZE) + `\n\n... (${content.length - PREVIEW_SIZE} more chars indexed)`
            : content;
          output.push('');
          output.push('Preview:');
          output.push(preview);
        }

        const outputText = output.join('\n') + suggestNextTool("mcx_fetch");
        trackToolUsage('mcx_fetch');
      } catch (error) {
        logger.error("mcx_fetch error", error);
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

      // Get top used methods for frecency display (abbreviated to save tokens)
      const abbreviate = (s: string, max = 8) => s.length > max ? s.slice(0, max) : s;
      const topMethods = [...methodUsage.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([method, count]) => {
          const [adapter, fn] = method.split('.');
          return `${abbreviate(adapter, 4)}.${abbreviate(fn)}(${count})`;
        });

      // Context efficiency calculations
      const sessionMin = Math.floor((Date.now() - tokenStats.sessionStart) / 60000);
      const sessionTime = sessionMin < 60 ? sessionMin + 'm' : Math.floor(sessionMin/60) + 'h' + (sessionMin%60) + 'm';
      const saved = tokenStats.totalRaw - tokenStats.totalChars;
      const savePct = tokenStats.totalRaw > 0 ? Math.round((saved / tokenStats.totalRaw) * 100) : 0;
      const barWidth = 20;
      const filledActual = tokenStats.totalRaw > 0 ? Math.min(barWidth, Math.max(1, Math.round((tokenStats.totalChars / tokenStats.totalRaw) * barWidth))) : 0;
      const barWithout = '█'.repeat(barWidth);
      const barWith = '█'.repeat(filledActual) + '░'.repeat(barWidth - filledActual);
      // Build table for tool breakdown
      const toolData = [...tokenStats.byTool.entries()]
        .sort((a, b) => b[1].chars - a[1].chars)
        .slice(0, 8)
        .map(([tool, s]) => ({
          tool: tool.replace('mcx_', ''),
          calls: s.calls,
          bytes: formatBytes(s.chars),
          saved: s.raw > 0 && s.raw > s.chars ? '-' + Math.round(((s.raw - s.chars) / s.raw) * 100) + '%' : '',
        }));
      
      const toolBreakdown = toolData.length > 0 ? [
        '┌──────────────┬───────┬──────────┬─────────┐',
        '│ Tool         │ Calls │ Bytes    │ Saved   │',
        '├──────────────┼───────┼──────────┼─────────┤',
        ...toolData.map(t => 
          '│ ' + t.tool.padEnd(12) + ' │ ' + String(t.calls).padStart(5) + ' │ ' + t.bytes.padStart(8) + ' │ ' + t.saved.padStart(7) + ' │'
        ),
        '└──────────────┴───────┴──────────┴─────────┘',
      ] : [];

      const output: string[] = ['MCX Session Stats', '─────────────────', ''];
      
      if (tokenStats.totalCalls > 0) {
        output.push('📊 Context Efficiency');
        if (saved > 0) {
          output.push('   Without MCX: |' + barWithout + '| ' + formatBytes(tokenStats.totalRaw));
          output.push('   With MCX:    |' + barWith + '| ' + formatBytes(tokenStats.totalChars) + ' (' + savePct + '% saved)');
          output.push('');
          
          // Enhanced metrics (better than context-mode's arbitrary formula)
          const tokensKept = Math.round(saved / 4);  // ~4 chars per token (industry standard)
          const contextWindow = 200000;  // Opus/Sonnet context window
          const contextPreserved = (tokensKept / contextWindow * 100).toFixed(1);
          const costPer1M = 5;  // $5/1M input tokens (Opus 4.5/4.6 pricing)
          const costSaved = (tokensKept / 1000000 * costPer1M).toFixed(3);
          
          // Format tokens nicely
          const tokensStr = tokensKept >= 1000 ? (tokensKept / 1000).toFixed(1) + 'K' : String(tokensKept);
          
          output.push('   🎯 ' + formatBytes(saved) + ' kept in sandbox');
          output.push('      → ' + tokensStr + ' tokens preserved (' + contextPreserved + '% of context window)');
          if (parseFloat(costSaved) >= 0.01) {
            output.push('      → $' + costSaved + ' context cost avoided');
          }
        } else {
          output.push('   ' + formatBytes(tokenStats.totalChars) + ' in ' + tokenStats.totalCalls + ' calls');
        }
        output.push('');
        if (toolBreakdown.length > 0) {
          output.push('📈 By Tool');
          output.push(...toolBreakdown);
          output.push('');
        }
      } else {
        output.push('No tool calls yet.');
        output.push('');
      }
      
      output.push('⏱️ Session: ' + sessionTime + ' | ' + executionCounter + ' executions | ' + searchCallCount + ' searches');
      if (fsBytesRead > 0 || networkBytesIn > 0) {
        output.push('🔒 Sandbox I/O');
        if (fsBytesRead > 0) output.push('   FS reads: ' + formatBytes(fsBytesRead) + ' across ' + fsFilesRead + ' file' + (fsFilesRead !== 1 ? 's' : ''));
        if (networkBytesIn > 0) output.push('   Network: ' + formatBytes(networkBytesIn) + ' across ' + networkRequests + ' requests');
      }
      if (cacheHits > 0) {
        output.push('💾 Cache');
        output.push('   Hits: ' + cacheHits + ' (saved ' + formatBytes(cacheBytesSaved) + ')');
      }
      if (variables.length > 0) output.push('📦 Variables: ' + variables.map(v => '$' + v).join(', '));
      if (sources.length > 0) output.push('📚 Indexed: ' + sources.length + ' sources, ' + totalChunks + ' chunks');
      
      // Version info
      const currentVersion = '0.3.24';
      output.push('');
      output.push('📦 Version: v' + currentVersion);

      return { content: [{ type: "text" as const, text: output.join('\n') }] };
    }
  );

  // Tool: mcx_spawn (Background execution)
  const SpawnInputSchema = z.object({
    code: z.string().min(1).describe("Code to run in background"),
    label: z.string().optional().describe("Optional label for the task"),
  });
  type SpawnInput = z.infer<typeof SpawnInputSchema>;

  server.registerTool(
    "mcx_spawn",
    {
      title: "Background Execution",
      description: `Run code in background, returns immediately with task ID.

Examples:
- mcx_spawn({ code: "await slowApi.processData()" })
- mcx_spawn({ code: "poll(...)", label: "data-sync" })

Check status with mcx_tasks. Results stored as $task_N.`,
      inputSchema: SpawnInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: SpawnInput) => {
      const taskId = params.label || generateTaskId();

      // Check if label already exists and is running
      if (params.label && backgroundTasks.has(taskId)) {
        const existing = backgroundTasks.get(taskId)!;
        if (existing.status === 'running') {
          return {
            content: [{ type: "text" as const, text: `Task "${taskId}" already running` }],
            isError: true,
          };
        }
      }

      const task: BackgroundTask = {
        id: taskId,
        code: params.code.slice(0, 100) + (params.code.length > 100 ? '...' : ''),
        status: 'running',
        startedAt: Date.now(),
        logs: [],
      };

      backgroundTasks.set(taskId, task);

      // Run in background (don't await)
      runBackgroundTask(taskId, params.code);

      return {
        content: [{ type: "text" as const, text: `Started ${taskId}. Check with mcx_tasks, result in $${taskId}` }],
        structuredContent: { taskId, status: 'running' },
      };
    }
  );

  // Tool: mcx_tasks (List/check background tasks)
  const TasksInputSchema = z.object({
    id: z.string().optional().describe("Get specific task by ID"),
    status: z.enum(['all', 'running', 'completed', 'failed']).optional().default('all'),
  });
  type TasksInput = z.infer<typeof TasksInputSchema>;

  server.registerTool(
    "mcx_tasks",
    {
      title: "Background Tasks",
      description: `List or check background tasks started with mcx_spawn.

Examples:
- mcx_tasks() → list all tasks
- mcx_tasks({ status: "running" }) → only running
- mcx_tasks({ id: "task_1" }) → specific task details`,
      inputSchema: TasksInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: TasksInput) => {
      // Specific task lookup
      if (params.id) {
        const task = backgroundTasks.get(params.id);
        if (!task) {
          return {
            content: [{ type: "text" as const, text: `Task "${params.id}" not found` }],
            isError: true,
          };
        }

        const duration = formatTaskDuration(task);

        const output = [
          `Task: ${task.id}`,
          `Status: ${task.status}`,
          `Duration: ${duration}`,
          `Code: ${task.code}`,
        ];

        if (task.error) {
          output.push(`Error: ${task.error}`);
        }
        if (task.logs.length > 0) {
          output.push(`Logs: ${task.logs.slice(0, 5).join(', ')}`);
        }
        if (task.status === 'completed') {
          output.push(`Result in: $${task.id}`);
        }

        return { content: [{ type: "text" as const, text: output.join('\n') }] };
      }

      // List tasks
      let tasks = [...backgroundTasks.values()];
      if (params.status !== 'all') {
        tasks = tasks.filter(t => t.status === params.status);
      }

      if (tasks.length === 0) {
        return { content: [{ type: "text" as const, text: 'No background tasks.' }] };
      }

      const output = ['Background Tasks', '────────────────'];
      for (const task of tasks.slice(0, 10)) {
        const icon = task.status === 'running' ? '⏳' : task.status === 'completed' ? '✓' : '✗';
        const duration = formatTaskDuration(task, true);
        output.push(`${icon} ${task.id}: ${task.status} (${duration})`);
      }

      if (tasks.length > 10) {
        output.push(`... +${tasks.length - 10} more`);
      }

      return { content: [{ type: "text" as const, text: output.join('\n') }] };
    }
  );

  // Tool: mcx_tree (JSON Tree Walker)
  const TreeInputSchema = z.object({
    path: z.string().describe("Path to explore, e.g. $result.data[0].items or $search.methods"),
    depth: z.coerce.number().optional().default(1).describe("Depth to show (default: 1)"),
  });
  type TreeInput = z.infer<typeof TreeInputSchema>;

  server.registerTool(
    "mcx_tree",
    {
      title: "JSON Tree Walker",
      description: `Navigate large JSON results without loading full content.

Examples:
- mcx_tree({ path: "$result" }) → show root structure
- mcx_tree({ path: "$result.data" }) → show data structure
- mcx_tree({ path: "$result.data[0]" }) → show first item
- mcx_tree({ path: "$search.methods", depth: 2 }) → deeper view`,
      inputSchema: TreeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: TreeInput) => {
      const state = getSandboxState();

      // Parse path: $varname.key1.key2[0].key3 (varname can include hyphens)
      const pathMatch = params.path.match(/^\$([\w-]+)(.*)$/);
      if (!pathMatch) {
        return {
          content: [{ type: "text" as const, text: `Invalid path: ${params.path}. Must start with $varname` }],
          isError: true,
        };
      }

      const [, varName, restPath] = pathMatch;
      let value = state.get(varName);

      if (value === undefined) {
        const available = Array.from(state.keys()).map(k => '$' + k).join(', ');
        return {
          content: [{ type: "text" as const, text: `Variable $${varName} not found. Available: ${available || 'none'}` }],
          isError: true,
        };
      }

      // Navigate the path
      if (restPath) {
        const segments = restPath.match(/\.(\w+)|\[(\d+)\]/g) || [];
        for (const seg of segments) {
          if (value === null || value === undefined) break;
          if (seg.startsWith('.')) {
            const key = seg.slice(1);
            value = (value as Record<string, unknown>)[key];
          } else if (seg.startsWith('[')) {
            const idx = parseInt(seg.slice(1, -1), 10);
            value = (value as unknown[])[idx];
          }
        }
      }

      if (value === undefined) {
        return {
          content: [{ type: "text" as const, text: `Path not found: ${params.path}` }],
          isError: true,
        };
      }

      // Generate tree view
      const describeValue = (v: unknown, depth: number, indent = ""): string[] => {
        if (v === null) return [`${indent}null`];
        if (v === undefined) return [`${indent}undefined`];

        const type = typeof v;
        if (type === "string") {
          const str = v as string;
          return [`${indent}string (${str.length} chars)${str.length <= 50 ? `: "${str}"` : ""}`];
        }
        if (type === "number" || type === "boolean") {
          return [`${indent}${type}: ${v}`];
        }
        if (Array.isArray(v)) {
          const lines = [`${indent}array (${v.length} items)`];
          if (depth > 0 && v.length > 0) {
            // Show sample of first few items
            const sample = v.slice(0, 3);
            for (let i = 0; i < sample.length; i++) {
              lines.push(`${indent}  [${i}]:`);
              lines.push(...describeValue(sample[i], depth - 1, indent + "    "));
            }
            if (v.length > 3) {
              lines.push(`${indent}  ... +${v.length - 3} more`);
            }
          }
          return lines;
        }
        if (type === "object") {
          const obj = v as Record<string, unknown>;
          const keys = Object.keys(obj);
          const lines = [`${indent}object (${keys.length} keys)`];
          if (depth > 0) {
            for (const key of keys.slice(0, 10)) {
              lines.push(`${indent}  ${key}:`);
              lines.push(...describeValue(obj[key], depth - 1, indent + "    "));
            }
            if (keys.length > 10) {
              lines.push(`${indent}  ... +${keys.length - 10} more keys`);
            }
          } else {
            lines.push(`${indent}  keys: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", ..." : ""}`);
          }
          return lines;
        }
        return [`${indent}${type}`];
      };

      const output = [
        `Tree: ${params.path}`,
        "─".repeat(Math.min(40, params.path.length + 6)),
        ...describeValue(value, params.depth),
      ];

      return { content: [{ type: "text" as const, text: output.join("\n") }] };
    }
  );

  // Tool: mcx_watch (Project Indexing)
  const WatchInputSchema = z.object({
    projects: z.array(z.string()).describe("Array of project directory paths to watch and index"),
    action: z.enum(["add", "remove", "list", "clear"]).default("add").describe("Action: add (default), remove, list, or clear projects"),
  });
  type WatchInput = z.infer<typeof WatchInputSchema>;

  server.registerTool(
    "mcx_watch",
    {
      title: "Watch Projects",
      description: `Manage which project directories are watched for automatic FTS5 content indexing.

Examples:
- mcx_watch({ projects: ["/path/to/project"] }) - Add project to watch
- mcx_watch({ projects: [], action: "list" }) - List watched projects
- mcx_watch({ projects: ["/path"], action: "remove" }) - Stop watching

The daemon automatically indexes file changes in watched projects for later search via mcx_search.`,
      inputSchema: WatchInputSchema,
      annotations: { readOnlyHint: false },
    },
    async (params: WatchInput): Promise<MCP.CallToolResult> => {
      if (!FileFinderClass) {
        return { content: [{ type: "text" as const, text: "FFF not available - cannot watch projects" }], isError: true };
      }

      const { projects, action } = params;

      if (action === "list") {
        const watched = Array.from(watchedProjects.keys());
        if (watched.length === 0) {
          return { content: [{ type: "text" as const, text: "No projects being watched. Use mcx_watch({ projects: [\"/path\"] }) to add." }] };
        }
        return { content: [{ type: "text" as const, text: `Watching ${watched.length} project(s):\n${watched.map(p => `  - ${p}`).join("\n")}` }] };
      }

      if (action === "clear") {
        stopDaemon();
        for (const [, finder] of watchedProjects) {
          finder.destroy();
        }
        watchedProjects.clear();
        return { content: [{ type: "text" as const, text: "Cleared all watched projects" }] };
      }

      if (action === "remove") {
        const removed: string[] = [];
        for (const projectPath of projects) {
          const normalized = resolve(projectPath);
          const finder = watchedProjects.get(normalized);
          if (finder) {
            finder.destroy();
            watchedProjects.delete(normalized);
            removed.push(normalized);
          }
        }
        // Restart daemon with remaining projects
        if (watchedProjects.size > 0) {
          startDaemon(watchedProjects);
        } else {
          stopDaemon();
        }
        return { content: [{ type: "text" as const, text: removed.length > 0 ? `Stopped watching: ${removed.join(", ")}` : "No matching projects found" }] };
      }

      // action === "add"
      const added: string[] = [];
      const errors: string[] = [];

      for (const projectPath of projects) {
        const normalized = resolve(projectPath);
        
        // Skip if already watching
        if (watchedProjects.has(normalized)) {
          continue;
        }

        // Create new FileFinder for this project (unique frecency DB per project)
        const projectHash = basename(normalized).replace(/[^a-zA-Z0-9]/g, '_');
        const init = FileFinderClass.create({
          basePath: normalized,
          frecencyDbPath: join(getMcxHomeDir(), `frecency-${projectHash}.db`),
        });

        if (init.ok) {
          init.value.waitForScan(5000);
          watchedProjects.set(normalized, init.value);
          added.push(normalized);
        } else {
          errors.push(`${normalized}: ${init.error}`);
        }
      }

      // Start/restart daemon with all watched projects
      if (watchedProjects.size > 0) {
        startDaemon(watchedProjects);
      }

      const result: string[] = [];
      if (added.length > 0) {
        result.push(`Now watching: ${added.join(", ")}`);
      }
      if (errors.length > 0) {
        result.push(`Errors: ${errors.join("; ")}`);
      }
      result.push(`Total projects watched: ${watchedProjects.size}`);

      return { content: [{ type: "text" as const, text: result.join("\n") }] };
    }
  );

  // Tool: mcx_doctor (Diagnostics)
  server.registerTool(
    "mcx_doctor",
    {
      title: "MCX Diagnostics",
      description: "Run diagnostics to check MCX health: runtime, database, adapters, sandbox.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];

      // 1. Bun runtime
      try {
        const bunVersion = Bun.version;
        checks.push({ name: "Bun runtime", status: "pass", detail: `v${bunVersion}` });
      } catch {
        checks.push({ name: "Bun runtime", status: "fail", detail: "Not available" });
      }

      // 2. SQLite/FTS5
      try {
        const store = getContentStore();
        const sources = store.getSources();
        checks.push({ name: "SQLite/FTS5", status: "pass", detail: `${sources.length} sources indexed` });
      } catch (e) {
        checks.push({ name: "SQLite/FTS5", status: "fail", detail: String(e) });
      }

      // 3. Adapters loaded
      const adapterCount = adapters.length;
      const lazyCount = adapters.filter(a => a.__lazy).length;
      if (adapterCount > 0) {
        const detail = lazyCount > 0 ? `${adapterCount} loaded (${lazyCount} lazy)` : `${adapterCount} loaded`;
        checks.push({ name: "Adapters", status: "pass", detail });
      } else {
        checks.push({ name: "Adapters", status: "warn", detail: "None loaded" });
      }

      // 4. Sandbox test (BunWorkerSandbox is stateless - each execute creates/terminates its own worker)
      try {
        const sandbox = new BunWorkerSandbox({ timeout: 1000 });
        const result = await sandbox.execute<number>("1 + 1", { adapters: {} });
        if (result.success && result.value === 2) {
          checks.push({ name: "Sandbox", status: "pass", detail: "Execution OK" });
        } else if (result.success) {
          checks.push({ name: "Sandbox", status: "warn", detail: `Unexpected: ${JSON.stringify(result.value)}` });
        } else {
          checks.push({ name: "Sandbox", status: "fail", detail: result.error?.message || "Unknown error" });
        }
      } catch (e) {
        checks.push({ name: "Sandbox", status: "fail", detail: String(e) });
      }

      // 5. FFF (optional)
      if (fileFinder) {
        checks.push({ name: "FFF", status: "pass", detail: "Initialized" });
      } else {
        checks.push({ name: "FFF", status: "warn", detail: "Not available (optional)" });
      }

      // 6. MCX version
      const pkg = await import("../../package.json");
      checks.push({ name: "Version", status: "pass", detail: `v${pkg.version}` });

      // Format output
      const icon = (s: "pass" | "warn" | "fail") => s === "pass" ? "[x]" : s === "warn" ? "[~]" : "[ ]";
      const output = [
        "MCX Diagnostics",
        "───────────────",
        ...checks.map(c => `${icon(c.status)} ${c.name}: ${c.detail}`),
        "",
        `${checks.filter(c => c.status === "pass").length}/${checks.length} checks passed`,
      ];

      return { content: [{ type: "text" as const, text: output.join('\n') }] };
    }
  );

  // Tool: mcx_upgrade
  server.registerTool(
    "mcx_upgrade",
    {
      title: "MCX Self-Upgrade",
      description: "Get command to upgrade MCX to latest version.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const pkg = await import("../../package.json");
      const currentVersion = pkg.version;
      const upgradeCmd = "bun add -g @papicandela/mcx-cli@latest";

      const output = [
        `Current: v${currentVersion}`,
        "",
        "To upgrade, run:",
        `  ${upgradeCmd}`,
        "",
        "Then restart your MCP session.",
      ];

      return { content: [{ type: "text" as const, text: output.join('\n') }] };
    }
  );

  // Tool: mcx_find (FFF fuzzy file search)
  const FindInputSchema = z.object({
    query: z.string().optional().describe("Fuzzy search query. Supports: *.ext, !exclude, /path/, status:modified"),
    pattern: z.string().optional().describe("Alias for query (for compatibility)"),
    path: z.string().optional().describe("Directory to search in (absolute path). Defaults to cwd."),
    glob: z.string().optional().describe("File pattern filter (e.g., *.tsx, **/*.ts)"),
    limit: z.coerce.number().optional().default(20).describe("Max results (default: 20)"),
  }).transform(({ pattern, glob, ...rest }) => ({
    ...rest,
    query: glob ? `${glob} ${rest.query || pattern || ""}`.trim() : (rest.query || pattern || ""),
  }));
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

Use path param to search in a different directory (e.g., path: "D:/projects/myapp").

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
      if (!params.query) {
        return { content: [{ type: "text" as const, text: "Missing query or pattern parameter." }], isError: true };
      }

      // Resolve symlinks so FFF searches the actual directory
      let searchPath = params.path;
      if (searchPath) {
        try {
          searchPath = await realpath(searchPath);
        } catch {
          // If realpath fails (e.g., path doesn't exist), use original path
        }
      }

      return withFinder(searchPath, (finder) => {
        const result = finder.fileSearch(params.query, { pageSize: params.limit });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Search failed: ${result.error}` }], isError: true };
        }

        const { items, totalMatched } = result.value;
        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: "No files found." }] };
        }

        // Proximity reranking: compute scores once, use for sort and display
        const proxScores = lastAccessedDir
          ? new Map(items.map(f => [f.path, getProximityScore(f.path)]))
          : null;

        const rankedItems = proxScores
          ? [...items].sort((a, b) => (proxScores.get(b.path) || 0) - (proxScores.get(a.path) || 0))
          : items;

        // Calculate raw size of full result for token tracking
        const fullOutput = items.map(f => f.relativePath + (f.gitStatus !== "clean" ? ` [${f.gitStatus}]` : ""));
        const rawBytes = JSON.stringify(fullOutput).length;
        
        const output = [
          `Found ${totalMatched} files (showing ${rankedItems.length}):`,
          "",
          ...rankedItems.map((f) => {
            const status = f.gitStatus !== "clean" ? ` [${f.gitStatus}]` : "";
            const prox = proxScores && (proxScores.get(f.path) || 0) > 0.5 ? " ★" : "";
            return `${f.relativePath}${status}${prox}`;
          }),
        ];

        // Dynamic tip from first result (Optimization #4)
        const dynamicTip = rankedItems[0] 
          ? `\n→ Next: mcx_file({ path: "${rankedItems[0].relativePath}" })`
          : suggestNextTool("mcx_find");

        const outputText = output.join("\n") + dynamicTip;
        return { content: [{ type: "text" as const, text: outputText }], toolResult: outputText, _rawBytes: rawBytes };

      });
    }
  );

  // Tool: mcx_grep (FFF content search)
  const GrepInputSchema = z.object({
    query: z.string().optional().describe("Search pattern. Prefix with *.ext or path/ to filter files."),
    pattern: z.string().optional().describe("Alias for query (for compatibility)"),
    path: z.string().optional().describe("Directory to search in (absolute path). Defaults to cwd."),
    glob: z.string().optional().describe("File pattern filter (e.g., *.tsx, **/*.ts)"),
    mode: z.enum(["plain", "regex", "fuzzy"]).optional().default("plain").describe("Search mode"),
    limit: z.coerce.number().optional().default(50).describe("Max matches (default: 50)"),
  }).transform(({ pattern, glob, ...rest }) => ({
    ...rest,
    // Prepend glob filter to query if provided (FFF query syntax)
    query: glob ? `${glob} ${rest.query || pattern || ""}`.trim() : (rest.query || pattern || ""),
  }));
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

Use path param to search in a different directory (e.g., path: "D:/projects/myapp").

Modes:
- plain: Literal text match (fast)
- regex: Regular expression
- fuzzy: Typo-tolerant fuzzy match

Tip: Use results to find line numbers, then mcx_edit with line mode.`,
      inputSchema: GrepInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: GrepInput) => {
      if (!params.query) {
        return { content: [{ type: "text" as const, text: "Missing query or pattern parameter." }], isError: true };
      }

      // Resolve symlinks so FFF searches the actual directory
      let searchPath = params.path;
      if (searchPath) {
        try {
          searchPath = await realpath(searchPath);
        } catch {
          // If realpath fails (e.g., path doesn't exist), use original path
        }
      }

      return withFinder(searchPath, (finder) => {
        const result = finder.grep(params.query, { mode: params.mode, pageLimit: params.limit });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Grep failed: ${result.error}` }], isError: true };
        }

        const { items, totalMatched, totalFilesSearched } = result.value;

        // Workflow tracking (Optimization #5)
        trackToolUsage('mcx_grep');

        // Track grep calls for progressive tips (Optimization #9)
        const now = Date.now();
        if (now - grepCallLog.firstCall > THROTTLE_WINDOW_MS) {
          grepCallLog.count = 1;
          grepCallLog.firstCall = now;
        } else {
          grepCallLog.count++;
        }

        if (items.length === 0) {
          return { content: [{ type: "text" as const, text: `No matches in ${totalFilesSearched} files.` }] };
        }

        // Calculate raw size for token tracking (full items before truncation)
        const rawBytes = JSON.stringify(items).length;

        const output = [`${totalMatched} matches in ${totalFilesSearched} files (showing ${items.length}):`, ""];

        // Group by file
        const byFile = new Map<string, typeof items>();
        for (const item of items) {
          const existing = byFile.get(item.relativePath) || [];
          existing.push(item);
          byFile.set(item.relativePath, existing);
        }

        // Sort files by proximity
        const fileKeys = [...byFile.keys()];
        const proxScores = lastAccessedDir ? new Map(fileKeys.map(f => [f, getProximityScore(f)])) : null;
        const sortedFiles = proxScores
          ? [...byFile.entries()].sort((a, b) => (proxScores.get(b[0]) || 0) - (proxScores.get(a[0]) || 0))
          : [...byFile.entries()];

        for (const [file, matches] of sortedFiles) {
          const prox = proxScores && (proxScores.get(file) || 0) > 0.5 ? " ★" : "";
          output.push(`${file}${prox}:`);
          for (const m of matches.slice(0, 5)) {
            output.push(`  ${m.lineNumber}: ${m.lineContent.trim().slice(0, 100)}`);
          }
          if (matches.length > 5) output.push(`  ... +${matches.length - 5} more matches`);
        }

        // Progressive tips based on grep call count (Optimization #9)
        const firstFile = sortedFiles[0];
        const firstLineNum = firstFile?.[1][0]?.lineNumber || 1;
        const firstPath = firstFile?.[0] || '';
        
        let dynamicTip: string;
        if (grepCallLog.count === 1) {
          // 1st grep: suggest exploring the match
          dynamicTip = `\n→ Next: mcx_file({ path: "${firstPath}", code: "around(${firstLineNum}, 20)" })`;
        } else if (grepCallLog.count === 2) {
          // 2nd grep: hint about batch/search options
          dynamicTip = `\n→ For multiple patterns: mcx_batch, or mode: "regex" with "p1|p2"`;
        } else {
          // 3rd+: warning about inefficiency
          dynamicTip = `\n💡 Multiple greps detected. Consider mcx_batch for parallel searches or mcx_search if content is indexed.`;
        }

        const outputText = output.join("\n") + dynamicTip;
        return { content: [{ type: "text" as const, text: outputText }], toolResult: outputText, _rawBytes: rawBytes };

      });
    }
  );

  // Tool: mcx_related (find related files by imports/exports)
  const RelatedInputSchema = z.object({
    file: z.string().describe("File path to find related files for"),
  });
  type RelatedInput = z.infer<typeof RelatedInputSchema>;

  server.registerTool(
    "mcx_related",
    {
      title: "Find Related Files",
      description: `Find files related to a given file by analyzing imports and exports.

Returns:
- Files that import the given file
- Files that the given file imports
- Files with similar names in the same directory

Useful for understanding code dependencies before making changes.`,
      inputSchema: RelatedInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: RelatedInput) => {
      const targetFile = params.file;
      type RelationType = "imports" | "imported-by" | "sibling";
      const related = new Map<string, { relation: RelationType }>();

      // Helper to extract import paths from file content (uses hoisted IMPORT_REGEX)
      const extractImports = (content: string): string[] => {
        const imports: string[] = [];
        IMPORT_REGEX.lastIndex = 0; // Reset stateful regex
        let match;
        while ((match = IMPORT_REGEX.exec(content)) !== null) {
          const importPath = match[1] || match[2];
          if (importPath && !importPath.startsWith("node_modules")) {
            imports.push(importPath);
          }
        }
        return imports;
      };

      // Resolve relative import to absolute path (parallel extension check)
      const resolveImport = async (fromFile: string, importPath: string): Promise<string | null> => {
        if (!importPath.startsWith(".")) return null;
        const dir = path.dirname(fromFile);
        const resolved = path.resolve(dir, importPath);
        // Check all extensions in parallel
        const candidates = RESOLVE_EXTENSIONS.map(ext => resolved + ext);
        const results = await Promise.all(candidates.map(p => Bun.file(p).exists()));
        const idx = results.findIndex(Boolean);
        return idx >= 0 ? candidates[idx] : null;
      };

      // 1. Find what this file imports (outgoing) - parallel resolution
      try {
        const targetContent = await Bun.file(targetFile).text();
        const imports = extractImports(targetContent);
        const resolved = await Promise.all(imports.map(imp => resolveImport(targetFile, imp)));
        for (const r of resolved) {
          if (r) {
            const relPath = path.relative(process.cwd(), r);
            related.set(relPath, { relation: "imports" });
          }
        }
      } catch {
        // File might not exist or be readable
      }

      // 2. Find files that import this file (incoming) using grep
      if (fileFinder) {
        const basename = path.basename(targetFile).replace(/\.(ts|tsx|js|jsx)$/, "");
        const searchResult = fileFinder.grep(basename, { glob: "*.{ts,tsx,js,jsx}", pageSize: 100 });
        if (searchResult.ok) {
          for (const match of searchResult.value.items) {
            if (match.path === targetFile) continue;
            if (isExcludedPath(match.path)) continue;
            // Check if it's actually importing our file
            const content = match.lineContent;
            if (content.includes("import") || content.includes("require")) {
              const relPath = path.relative(process.cwd(), match.path);
              if (!related.has(relPath)) {
                related.set(relPath, { relation: "imported-by" });
              }
            }
          }
        }
      }

      // 3. Find sibling files with similar names
      const dir = path.dirname(targetFile);
      const baseName = path.basename(targetFile).replace(/\.(ts|tsx|js|jsx)$/, "");
      try {
        const siblings = await Array.fromAsync(new Bun.Glob("*").scan(dir));
        for (const sibling of siblings) {
          const siblingBase = sibling.replace(/\.(ts|tsx|js|jsx|test|spec|stories).*$/, "");
          if (sibling !== path.basename(targetFile) && siblingBase === baseName) {
            const relPath = path.relative(process.cwd(), path.join(dir, sibling));
            if (!related.has(relPath)) {
              related.set(relPath, { relation: "sibling" });
            }
          }
        }
      } catch {
        // Directory might not exist
      }

      // Update proximity context for the target file
      updateProximityContext(targetFile);

      if (related.size === 0) {
        const msg = `No related files found for: ${targetFile}`;
        return { content: [{ type: "text" as const, text: msg }], toolResult: msg };
      }

      // Format output grouped by relation type
      const byRelation = new Map<string, string[]>();
      for (const [file, info] of related) {
        const list = byRelation.get(info.relation) || [];
        list.push(file);
        byRelation.set(info.relation, list);
      }

      const output: string[] = [`Related files for ${path.basename(targetFile)}:`, ""];

      const relationLabels: Record<RelationType, string> = {
        "imports": "This file imports:",
        "imported-by": "Imported by:",
        "sibling": "Related files in same directory:",
      };

      for (const [relation, files] of byRelation) {
        output.push(relationLabels[relation] || relation);
        for (const file of files.slice(0, 10)) {
          output.push(`  ${file}`);
        }
        if (files.length > 10) {
          output.push(`  ... +${files.length - 10} more`);
        }
        output.push("");
      }

      const outputText = output.join("\n") + suggestNextTool("mcx_related");
      return { content: [{ type: "text" as const, text: outputText }], toolResult: outputText };
    }
  );

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
  console.error(pc.dim(`[MCX] cwd: ${process.cwd()}`));

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
  console.error(pc.dim("Tools: mcx_execute, mcx_search, mcx_batch, mcx_file, mcx_edit, mcx_write, mcx_fetch, mcx_find, mcx_grep, mcx_related, mcx_stats, mcx_watch, mcx_doctor, mcx_upgrade, mcx_list, mcx_run_skill"));
  console.error(pc.dim(`Logs: ${logger.getLogPath()}`));
}

async function runHttp(port: number, fffSearchPath?: string) {
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
  // Save original cwd BEFORE any changes - this is where FFF should search
  const originalCwd = process.cwd();
  
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
    // Default: use global ~/.mcx/ directory for config/adapters
    // but keep original cwd for FFF file search
    const mcxHome = ensureMcxHomeDir();
    console.error(pc.dim(`[MCX] Config from: ${mcxHome}`));
    console.error(pc.dim(`[MCX] FFF search in: ${originalCwd}`));
    process.chdir(mcxHome);
  }

  if (options.transport === "http") {
    await runHttp(options.port || 3100, originalCwd);
  } else {
    await runStdio(originalCwd);
  }
}