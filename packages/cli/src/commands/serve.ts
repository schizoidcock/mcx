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

// Hoisted regex for import extraction (avoids recreation per call)
const IMPORT_REGEX = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { applyHybridFilter } from "./filters.js";
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
import { isDangerousEnvKey, isBlockedUrl, detectShellEscape } from "../utils/security";
import { analyzeCodeTraits, analyzeShellTraits, formatTraitWarnings } from "../utils/traits";
import { logger } from "../utils/logger";
import { getContentStore, searchWithFallback, getDistinctiveTerms, batchSearch, htmlToMarkdown, isHtml } from "../search";
import { getSandboxState } from "../sandbox";
import { loadSpecsFromAdapters } from "../spec";
import { mcxStats } from "../tools/stats.js";
import { mcxTasks } from "../tools/tasks.js";
import { mcxWatch } from "../tools/watch.js";
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
        proc.kill();
      }
    }
  } catch {
    // Last resort fallback - simple kill, no recursion
    proc.kill();
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
/** Track stored file variable names for enforcement (Optimization #13) */
const storedFileVars = new Map<string, string>();
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
  
  // Clean fileStoreTime, storedFileVars, and fileEditTime
  for (const [key, time] of fileStoreTime) {
    if (now - time > MAP_TTL_MS) {
      fileStoreTime.delete(key);
      storedFileVars.delete(key); // Clean variable name when store time expires
    }
  }
  for (const [key, time] of fileEditTime) {
    if (now - time > MAP_TTL_MS) fileEditTime.delete(key);
  }
  
  // Clean executeFailures
  for (const [key, val] of executeFailures) {
    if (now - val.lastTime > MAP_TTL_MS) executeFailures.delete(key);
  }
  
  // Clean linesCallTracker
  for (const [key, val] of linesCallTracker) {
    if (now - val.timestamp > LINES_HUNT_WINDOW_MS) linesCallTracker.delete(key);
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

/** Create a blocked/error MCP response */
const blockedResponse = (msg: string) => ({ 
  content: [{ type: "text" as const, text: msg }], 
  isError: true as const 
});

/** Sanitize string for JSON serialization (remove lone surrogates) */
const sanitizeForJson = (str: string): string => {
  // Remove lone surrogates (U+D800-U+DFFF) that would break JSON
  // These can appear when UTF-16 strings are improperly handled
  return str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
};

/** Workflow tracking for inefficiency detection (Optimization #5) */
const sessionWorkflow = {
  lastTools: [] as Array<{ tool: string; file?: string; timestamp: number }>,
  maxHistory: 10,
};

/** Track consecutive lines() calls per variable for hunting detection */
const linesCallTracker = new Map<string, { count: number; lastRange: [number, number]; timestamp: number }>();
const LINES_HUNT_THRESHOLD = 3; // Block on 3rd consecutive call
const LINES_HUNT_WINDOW_MS = 60_000; // Reset after 60s

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
  // Pattern: Same file read - now ENFORCED in mcx_file handler (Optimization #13)

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

  // Pattern: 5+ unique files read without processing (suggest mcx_tasks batch or storeAs)
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
               `Consider: mcx_tasks({ commands: [...] }) or process each file with code.`;
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
  ],
  mcx_grep: [
    { tool: "mcx_file", hint: "process matched file" },
    { tool: "mcx_find", hint: "find imports/exports via related param" },
  ],
  mcx_file: [
    { tool: "mcx_find", hint: "find related: mcx_find({ related: file })" },
    { tool: "mcx_edit", hint: "edit the file" },
  ],
  mcx_edit: [
    { tool: "mcx_find", hint: "check related files via related param" },
  ],
  mcx_write: [
    { tool: "mcx_find", hint: "find importers via related param" },
  ],
  mcx_tasks: [
    { tool: "mcx_find", hint: "find dependencies via related param" },
  ],
  mcx_fetch: [
    { tool: "mcx_search", hint: "search indexed content" },
  ],
  mcx_execute: [
    { tool: "mcx_search", hint: "search results or find methods" },
  ],
  mcx_search: [
    { tool: "mcx_execute", hint: "call discovered method" },
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
  batchResults: Record<string, { title: string; snippet: string }[]>,
  output: string[]
): number {
  let totalMatches = 0;
  for (const [query, results] of Object.entries(batchResults)) {
    totalMatches += results.length;
    output.push(`\n## ${query}\n`);
    if (results.length === 0) {
      output.push('(no matches)');
    } else {
      const sliced = results.slice(0, 3);
      for (let i = 0; i < sliced.length; i++) {
        output.push(`  - ${sliced[i].title}`);
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
// Grep Output Formatting
// ============================================================================

/** Max line width for grep output */
const GREP_MAX_LINE_WIDTH = 100;
/** Max matches to show per file */
const GREP_MAX_PER_FILE = 5;


/**
 * Truncate a line with window centered around match.
 * Pattern: 1/3 context before, 2/3 after the match.
 */
function cleanLine(line: string, maxLen = GREP_MAX_LINE_WIDTH, pattern?: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxLen) return trimmed;
  
  // If no pattern or pattern not found, simple center truncation
  if (!pattern) {
    // Account for "..." on both sides (6 chars total)
    const contentLen = maxLen - 6;
    const halfLen = Math.floor(contentLen / 2);
    return trimmed.slice(0, halfLen) + '...' + trimmed.slice(-halfLen);
  }
  
  // Find pattern position (case-insensitive)
  const lowerLine = trimmed.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  const matchIdx = lowerLine.indexOf(lowerPattern);
  
  if (matchIdx === -1) {
    // Pattern not found, simple center truncation
    const contentLen = maxLen - 6;
    const halfLen = Math.floor(contentLen / 2);
    return trimmed.slice(0, halfLen) + '...' + trimmed.slice(-halfLen);
  }
  
  // Center window around match: 1/3 before, 2/3 after
  // Account for potential "..." on both sides (6 chars reserved)
  const availableLen = maxLen - 6;
  const patternLen = Math.min(pattern.length, availableLen);
  const remaining = availableLen - patternLen;
  const beforeWindow = Math.floor(remaining / 3);
  const afterWindow = remaining - beforeWindow;
  
  let start = Math.max(0, matchIdx - beforeWindow);
  let end = Math.min(trimmed.length, matchIdx + pattern.length + afterWindow);
  
  // Determine if we need prefix/suffix
  const needsPrefix = start > 0;
  const needsSuffix = end < trimmed.length;
  
  // If we don't need one side's ellipsis, give that space to content
  if (!needsPrefix && needsSuffix) {
    // No prefix needed, extend end
    end = Math.min(trimmed.length, maxLen - 3);
  } else if (needsPrefix && !needsSuffix) {
    // No suffix needed, extend start
    start = Math.max(0, trimmed.length - (maxLen - 3));
  }
  
  const prefix = needsPrefix ? '...' : '';
  const suffix = needsSuffix ? '...' : '';
  
  return prefix + trimmed.slice(start, end) + suffix;
}

/**
 * Format grep results with file grouping, smart truncation, and +N hidden counts.
 */
interface GrepMatch {
  relativePath: string;
  lineNumber: number;
  lineContent: string;
}

interface FormatGrepOptions {
  maxPerFile?: number;
  maxLineWidth?: number;
  pattern?: string;
  proxScores?: Map<string, number> | null;
}

function formatGrepMCX(
  items: GrepMatch[],
  totalMatched: number,
  totalFilesSearched: number,
  options: FormatGrepOptions = {}
): { output: string; hiddenMatches: number; hiddenFiles: number } {
  const {
    maxPerFile = GREP_MAX_PER_FILE,
    maxLineWidth = GREP_MAX_LINE_WIDTH,
    pattern,
    proxScores,
  } = options;

  // Group by file
  const byFile = new Map<string, GrepMatch[]>();
  for (const item of items) {
    const existing = byFile.get(item.relativePath) || [];
    existing.push(item);
    byFile.set(item.relativePath, existing);
  }

  // Sort files by proximity if available
  const sortedFiles = proxScores
    ? [...byFile.entries()].sort((a, b) => (proxScores.get(b[0]) || 0) - (proxScores.get(a[0]) || 0))
    : [...byFile.entries()];

  const lines: string[] = [];
  let hiddenMatches = 0;

  // Format each file
  for (const [file, matches] of sortedFiles) {
    const prox = proxScores && (proxScores.get(file) || 0) > 0.5 ? ' ★' : '';
    const displayPath = compactPath(file);
    
    // Show count if more matches than we'll display
    const fileHidden = matches.length > maxPerFile ? matches.length - maxPerFile : 0;
    hiddenMatches += fileHidden;
    
    const countSuffix = fileHidden > 0 ? ` (+${fileHidden})` : '';
    lines.push(`${displayPath}${prox}${countSuffix}:`);
    
    // Show limited matches with smart line truncation
    for (const m of matches.slice(0, maxPerFile)) {
      const cleanedLine = cleanLine(m.lineContent, maxLineWidth, pattern);
      lines.push(`  ${m.lineNumber}: ${cleanedLine}`);
    }
  }

  // Calculate total hidden (matches not shown at all due to items limit)
  const shownMatches = items.length;
  const totalHidden = totalMatched - shownMatches + hiddenMatches;

  // Header with counts
  const header = totalHidden > 0
    ? `${totalMatched} matches in ${totalFilesSearched} files (showing ${shownMatches - hiddenMatches}, +${totalHidden} hidden):`
    : `${totalMatched} matches in ${totalFilesSearched} files:`;

  return {
    output: [header, '', ...lines].join('\n'),
    hiddenMatches: totalHidden,
    hiddenFiles: 0,
  };
}

/**
 * Detect if output looks like grep/ripgrep output and format it.
 * Returns formatted output if detected, null otherwise.
 * 
 * Grep output patterns:
 * - file:line:content (grep -n, rg)
 * - file:line-content (grep -n with context)
 * - file-line-content (some grep variants)
 */
function detectAndFormatGrepOutput(output: string): string | null {
  // Normalize CRLF to LF and split
  const lines = output.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.length < 2) return null;
  
  // Pattern: file:linenum:content or file:linenum-content
  // Handle Windows paths (D:/path) by finding :NUMBER: or :NUMBER- pattern
  const grepPattern = /^(.+):(\d+)([:=-])(.*)$/;
  
  // Check if at least 60% of lines match grep pattern
  let matches = 0;
  const parsed: GrepMatch[] = [];
  
  for (const line of lines) {
    const match = line.match(grepPattern);
    if (match) {
      matches++;
      parsed.push({
        relativePath: match[1],
        lineNumber: parseInt(match[2], 10),
        lineContent: match[4],
      });
    }
  }
  
  const matchRatio = matches / lines.length;
  if (matchRatio < 0.6 || parsed.length < 3) {
    return null; // Not grep-like output
  }
  
  // Extract search pattern from command if visible in output (heuristic)
  // Look for commonly matched terms
  const allContent = parsed.map(p => p.lineContent).join(' ');
  
  // Format using existing function
  const totalMatched = parsed.length;
  const { output: formatted, hiddenMatches } = formatGrepMCX(
    parsed,
    totalMatched,
    new Set(parsed.map(p => p.relativePath)).size,
    { maxPerFile: GREP_MAX_PER_FILE, maxLineWidth: GREP_MAX_LINE_WIDTH }
  );
  
  return formatted;
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

/** Check if value is image metadata (placeholder after extraction) */
function isImageMetadata(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).__image__ === true;
}

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
  
  // String → check for grep-like output first, then truncate lines
  if (typeof result === 'string') {
    const normalized = result.replace(/\r\n/g, '\n');
    
    // Detect and format grep-like output (file:line:content pattern)
    const grepFormatted = detectAndFormatGrepOutput(normalized);
    if (grepFormatted) {
      return grepFormatted;
    }
    
    // Not grep-like, apply standard line truncation
    return normalized
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
  
  // String → normalize CRLF, sanitize surrogates, truncate long lines
  if (typeof value === 'string') {
    return sanitizeForJson(value)
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
  
  const snippet = text.slice(start, end).trim().replace(/\n{2,}/g, '\n\n').replace(/[ \t]+/g, ' ');
  return prefix + snippet + suffix;
}


/**
 * Format intent search results in compact format
 * Returns ~73% fewer tokens than verbose format
 */
function formatIntentResultsCompact(
  results: Array<{ title: string; snippet: string }>,
  intent: string,
  totalSections: number,
  totalLines: number,
  totalKB: string,
  sourceLabel: string,
  terms: string[]
): string {
  const lines: string[] = [];
  
  lines.push(`Indexed ${totalSections} sections as "${sourceLabel}" (${totalLines} lines, ${totalKB}KB)`);
  lines.push(`${results.length} matched "${intent}":`);
  lines.push('');
  
  // Compact: title only (first line often duplicates title)
  for (const r of results) {
    lines.push(`  - ${r.title}`);
  }
  
  if (terms.length > 0) {
    lines.push('');
    lines.push(`Terms: ${terms.slice(0, 10).join(', ')}`);
  }
  
  lines.push('');
  lines.push(`→ mcx_search({ query: "..." }) for full content`);
  
  return lines.join('\n');
}


/**
 * Enforce character limit on text output and sanitize for JSON
 */
function enforceCharacterLimit(text: string, limit: number = CHARACTER_LIMIT): { text: string; truncated: boolean } {
  // Sanitize first to remove lone surrogates that break JSON
  const sanitized = sanitizeForJson(text);
  if (sanitized.length <= limit) {
    return { text: sanitized, truncated: false };
  }
  const truncatedText = sanitized.slice(0, limit) + `\n\n... [Response truncated at ${limit} chars, original was ${sanitized.length}]`;
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
 * 
 * Ignores braces inside:
 * - Strings: "...", '...', `...`
 * - Regex: /.../ (heuristic: / after operator or at line start)
 * - Comments: // and block comments
 */
function checkBraceBalance(content: string): number {
  let balance = 0;
  let inString = false;
  let stringChar = '';
  let inRegex = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];
    
    // Handle newlines - reset line comment
    if (char === '\n') {
      inLineComment = false;
      continue;
    }
    
    // Skip line comments
    if (inLineComment) continue;
    
    // Handle block comments
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++; // skip /
      }
      continue;
    }
    
    // Detect comment start
    if (char === '/' && next === '/') {
      inLineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++; // skip *
      continue;
    }
    
    if (escaped) {
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    // Handle strings
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }
    
    // Handle regex
    if (inRegex) {
      if (char === '/') {
        inRegex = false;
      }
      continue;
    }
    
    if (char === '"' || char === "'" || char === '`') {
      inString = true;
      stringChar = char;
      continue;
    }
    
    // Detect regex start (heuristic: / after operator, paren, or at line start)
    if (char === '/') {
      const prevNonSpace = content.slice(0, i).trimEnd().slice(-1);
      if (!prevNonSpace || /[=(:,;\[{!&|?]/.test(prevNonSpace)) {
        inRegex = true;
        continue;
      }
    }
    
    if (char === '{') balance++;
    if (char === '}') balance--;
  }
  
  return balance;
}

/** Enforce shell command redirects to MCX tools. Returns error response or null. */
function enforceShellRedirects(cmd: string): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  // File operations → mcx_file
  // Match path: has extension (.ts), or path separator (/), or starts with ./
  const fileMatch = cmd.match(/\b(cat|head|tail|sed|awk|wc)\b.*?(["']?)([^\s|>"']*[\.\/\\][^\s|>"']+)\2/);
  if (fileMatch) {
    const filePath = fileMatch[3];
    const varName = filePath.split(/[\/\\]/).pop()?.replace(/\.[^.]+$/, '') || 'f';
    return blockedResponse(`Must use mcx_file for file operations\n💡 mcx_file({ path: "${filePath}", storeAs: "${varName}" }), then grep($${varName}, 'pattern')`);
  }
  
  // grep/rg → mcx_grep
  if (/\b(grep|rg)\s+/.test(cmd)) {
    return blockedResponse(`Must use mcx_grep instead\n💡 mcx_grep({ pattern: "...", path: "..." })`);
  }
  
  // find → mcx_find
  const findMatch = cmd.match(/\bfind\s+["']?([^\s|>"']*)/);
  if (findMatch) {
    return blockedResponse(`Must use mcx_find instead\n💡 mcx_find({ pattern: "...", path: "${findMatch[1] || '.'}" })`);
  }
  
  // curl/wget → mcx_fetch
  const curlMatch = cmd.match(/\b(curl|wget)\s+.*?(https?:\/\/[^\s"']+)/);
  if (curlMatch) {
    const url = curlMatch[2];
    return blockedResponse(`Must use mcx_fetch instead\n💡 mcx_fetch({ url: "${url}" })`);
  }
  
  return null;
}

/** Enforce Python code redirects to MCX tools. Returns error response or null. */
function enforcePythonRedirects(code: string): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  // File reading operations → mcx_file
  if (/\b(open\s*\(|with\s+open|Path\s*\(|pd\.read_\w+|pandas\.read_\w+)/.test(code)) {
    return blockedResponse(`Must use mcx_file for file reading\n💡 mcx_file({ path: "...", language: "python", code: "..." })`);
  }
  return null;
}

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
  if (matches.length === 0) return "No matches for '" + pattern + "'";
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
const tree = (obj, depth = 2, indent = '') => {
  if (obj === null) return indent + 'null';
  if (obj === undefined) return indent + 'undefined';
  const type = typeof obj;
  if (type === 'string') return indent + 'string (' + obj.length + ' chars)' + (obj.length <= 50 ? ': "' + obj + '"' : '');
  if (type === 'number' || type === 'boolean') return indent + type + ': ' + obj;
  if (Array.isArray(obj)) {
    let out = indent + 'array (' + obj.length + ' items)';
    if (depth > 0 && obj.length > 0) {
      const sample = obj.slice(0, 3);
      sample.forEach((item, i) => { out += '\\n' + tree(item, depth - 1, indent + '  [' + i + '] '); });
      if (obj.length > 3) out += '\\n' + indent + '  ... +' + (obj.length - 3) + ' more';
    }
    return out;
  }
  if (type === 'object') {
    const entries = Object.entries(obj).filter(([k]) => k !== '__raw');
    let out = indent + 'object (' + entries.length + ' keys)';
    if (depth > 0) {
      entries.slice(0, 10).forEach(([k, v]) => { out += '\\n' + tree(v, depth - 1, indent + '  ' + k + ': ').replace(indent + '  ' + k + ': ' + indent, indent + '  ' + k + ': '); });
      if (entries.length > 10) out += '\\n' + indent + '  ... +' + (entries.length - 10) + ' more keys';
    }
    return out;
  }
  return indent + type;
};
`;
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
  const toolContext: ToolContext = {
    contentStore: getContentStore(),
    sandbox,
    finder: null, // Lazy initialized via withFinder
    spec: cachedSpec,
    variables: { stored: getSandboxState(), lastResult: undefined },
    workflow: { lastTools: [], proximityContext: { recentFiles: [], recentPatterns: [] } },
    watchedProjects: new Map(),
    backgroundTasks,
    basePath: fffBasePath,
    fileHelpersCode: FILE_HELPERS_CODE,
  };
  
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
  console.error(pc.dim("Tools: mcx_execute, mcx_adapter, mcx_search, mcx_tasks, mcx_file, mcx_edit, mcx_write, mcx_fetch, mcx_stats, mcx_watch, mcx_doctor, mcx_upgrade, mcx_find, mcx_grep"));
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