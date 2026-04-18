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
import { runStdio } from "../server/index.js";
import { runHttp } from "../server/http.js";
import { 
  loadEnvFile, loadConfig, loadSkills, loadAdaptersFromDir, 
  toCamelCase, formatSignature, validateParams, buildAdapterContext,
  type Skill, type Adapter, type AdapterMethod, type MCXConfig 
} from "../server/factory.js";
import { createMcxServerCore } from "../server/core.js";
import { type FileFinder, isExcludedPath } from "../utils/fff";
import { coerceJsonArray } from "../utils/zod";
import { isDangerousEnvKey, isBlockedUrl, detectShellEscape, blockedResponse } from "../utils/security";
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
import { getAllPrefixed, setVariable, setLastResult } from "../context/variables.js";
import { createToolContext, FILE_HELPERS_CODE } from "../context/create.js";
import { loadSpecsFromAdapters } from "../spec";
import { mcxStats } from "../tools/stats.js";
import { mcxTasks } from "../tools/tasks.js";
import { mcxWatch } from "../tools/watch.js";
import { safeStringify } from "../tools/utils.js";
import { cleanLine } from "../utils/truncate.js";
import { cleanupGuards } from "../context/guards.js";
import { formatGrepMCX, type GrepMatch, type FormatGrepOptions } from "../tools/format-grep.js";
import { mcxDoctor } from "../tools/doctor.js";
import { mcxUpgrade } from "../tools/upgrade.js";
import { mcxFind } from "../tools/find.js";
import { mcxGrep } from "../tools/grep.js";
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
  const debugLogPath = path.join(getMcxHomeDir(), "logs", "debug.log");
  require("fs").appendFileSync(debugLogPath, `[${new Date().toISOString()}] UNCAUGHT EXCEPTION - pid: ${process.pid}, error: ${error}\n`);
  logger.uncaughtException(error);
  console.error(pc.red('[MCX] Uncaught exception:'), error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const debugLogPath = path.join(getMcxHomeDir(), "logs", "debug.log");
  require("fs").appendFileSync(debugLogPath, `[${new Date().toISOString()}] UNHANDLED REJECTION - pid: ${process.pid}, reason: ${reason}\n`);
  logger.unhandledRejection(reason);
  console.error(pc.red('[MCX] Unhandled rejection:'), reason);
});

// ============================================================================
// .env Loading
// ============================================================================

// loadEnvFile moved to server/factory.ts

// ============================================================================
// Types (CLI-specific, compatible with @papicandela/mcx-core)
// ============================================================================

// Note: These types are intentionally local to serve.ts for CLI-specific needs.
// They are compatible with the unified types in @papicandela/mcx-core.
// Types imported from ../server/factory.js

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

// Adapter loading functions moved to server/factory.ts
// runHttp moved to server/http.ts
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
