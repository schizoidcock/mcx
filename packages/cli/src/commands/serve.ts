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
// Throttling constants imported from tools/constants.js

/** File access tracking for progressive tips (Optimization #2+#3) */
const fileAccessLog = new Map<string, { count: number; firstAccess: number }>();




/** Grep call tracking for progressive tips (Optimization #9) */
const grepCallLog = { count: 0, firstCall: 0 };

/** Cleanup stale Map entries (called periodically) */
/** Evict oldest entries from map by timestamp field */
const evictOldest = <K, V extends { firstAccess: number }>(
  map: Map<K, V>, maxSize: number
): void => {
  if (map.size <= maxSize) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].firstAccess - b[1].firstAccess);
  for (let i = 0; i < sorted.length - maxSize; i++) map.delete(sorted[i][0]);
};

function cleanupStaleMaps(): void {
  const now = Date.now();
  for (const [key, val] of fileAccessLog) {
    if (now - val.firstAccess > MAP_TTL_MS) fileAccessLog.delete(key);
  }
  cleanupGuards(now);
  evictOldest(fileAccessLog, MAP_MAX_ENTRIES);
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleMaps, 5 * 60 * 1000);



/** Create a blocked/error MCP response */
// Using blockedResponse from utils/security.ts

// sanitizeForJson imported from utils/truncate

/** Workflow tracking for inefficiency detection (Optimization #5) */
const sessionWorkflow = {
  lastTools: [] as Array<{ tool: string; file?: string; timestamp: number }>,
  maxHistory: 10,
};







// MAX_PARAMS_*, MAX_DESC_LENGTH imported from tools/constants.js






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

/** Name-based example heuristics */
const NAME_EXAMPLES: Record<string, string> = {
  id: "123", limit: "10", count: "10", size: "10", pagesize: "10",
  offset: "0", start: "0", skip: "0", page: "1",
  email: '"user@example.com"', name: '"John Doe"', phone: '"+1234567890"',
  query: '"search term"', q: '"search term"', search: '"search term"',
};

/** Type-based fallbacks */
const TYPE_EXAMPLES: Record<string, string> = {
  number: "10", boolean: "true", "unknown[]": "[]", "Record<string, unknown>": "{}",
};

/** Get example by name pattern */
const getExampleByName = (name: string): string | null => {
  if (NAME_EXAMPLES[name]) return NAME_EXAMPLES[name];
  if (name.endsWith("_id") || name.endsWith("id")) return "123";
  if (name.includes("date")) return '"2024-01-15"';
  if (name.endsWith("url")) return '"https://example.com"';
  return null;
};

function getExampleValue(paramName: string, paramType: string, schemaExample?: unknown): string {
  if (schemaExample !== undefined) return JSON.stringify(schemaExample);
  const byName = getExampleByName(paramName.toLowerCase());
  if (byName) return byName;
  return TYPE_EXAMPLES[paramType] ?? '"..."';
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
