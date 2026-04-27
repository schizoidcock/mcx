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
import pc from "picocolors";

import { getMcxHomeDir, ensureMcxHomeDir, findProjectRoot, } from "../utils/paths";
import { runStdio } from "../server/index.js";
import { runHttp } from "../server/http.js";
import { logger } from "../utils/logger";
import {
  MAP_TTL_MS,
  MAP_MAX_ENTRIES,
} from "../tools/constants.js";
import { cleanupGuards } from "../context/guards.js";

import { createDebugger } from "../utils/debug.js";
const debug = createDebugger("cmdserve");


// ============================================================================
// Global Error Handlers (P0 - Critical for debugging crashes)
// ============================================================================

process.on('uncaughtException', (error) => {
  const debugLogPath = path.join(getMcxHomeDir(), "logs", "debug.log");
  require("node:fs").appendFileSync(debugLogPath, `[${new Date().toISOString()}] UNCAUGHT EXCEPTION - pid: ${process.pid}, error: ${error}\n`);
  logger.uncaughtException(error);
  console.error(pc.red('[MCX] Uncaught exception:'), error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const debugLogPath = path.join(getMcxHomeDir(), "logs", "debug.log");
  require("node:fs").appendFileSync(debugLogPath, `[${new Date().toISOString()}] UNHANDLED REJECTION - pid: ${process.pid}, reason: ${reason}\n`);
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


/** Dangerous env vars to filter from shell execution */

/** File access tracking for progressive tips (Optimization #2+#3) */
const fileAccessLog = new Map<string, { count: number; firstAccess: number }>();

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
