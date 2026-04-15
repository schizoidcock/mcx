/**
 * Session Logger for MCX
 *
 * Structure: ~/.mcx/logs/{YYYY-MM-DD}/{category}.toon
 * Format: TOON tabular arrays - header once, values appended
 * Cleanup: Deletes folders > 15 days old
 */

import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Constants
// ============================================================================

export const LOG_DIR = join(homedir(), ".mcx", "logs");
const MAX_DAYS = 15;

// Category schemas: field names for TOON tabular format
const SCHEMAS: Record<string, string[]> = {
  execute: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  file: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  search: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  fetch: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  adapter: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  tasks: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  stats: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
  session: ["ts", "level", "msg", "err"],
  other: ["ts", "tool", "ok", "ms", "ch", "raw", "err"],
};

// Tool to category mapping
const TOOL_CATEGORY: Record<string, string> = {
  mcx_execute: "execute",
  mcx_file: "file",
  mcx_edit: "file",
  mcx_write: "file",
  mcx_grep: "search",
  mcx_find: "search",
  mcx_search: "search",
  mcx_fetch: "fetch",
  mcx_adapter: "adapter",
  mcx_tasks: "tasks",
  mcx_watch: "tasks",
  mcx_stats: "stats",
  mcx_doctor: "stats",
  mcx_upgrade: "stats",
};

// ============================================================================
// State
// ============================================================================

let initialized = false;
let currentDate = "";
let currentDir = "";
const headerWritten = new Set<string>();

// ============================================================================
// Helpers
// ============================================================================

function getDateStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getTimeStr(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

function escapeValue(val: unknown): string {
  if (val === undefined || val === null || val === "") return "";
  const s = String(val);
  // Escape commas and newlines
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCSVLine(fields: string[], data: Record<string, unknown>): string {
  return fields.map(f => escapeValue(data[f])).join(",");
}

async function ensureDir(): Promise<string> {
  const date = getDateStr();

  if (date !== currentDate || !initialized) {
    currentDate = date;
    currentDir = join(LOG_DIR, date);
    headerWritten.clear(); // Reset headers for new day
    await mkdir(currentDir, { recursive: true });

    if (!initialized) {
      await cleanup();
      initialized = true;
    }
  }

  return currentDir;
}

async function cleanup(): Promise<void> {
  try {
    const entries = await readdir(LOG_DIR);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const entry of entries) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && entry < cutoffStr) {
        try {
          await rm(join(LOG_DIR, entry), { recursive: true });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

async function writeToCategory(category: string, event: Record<string, unknown>): Promise<void> {
  try {
    const dir = await ensureDir();
    const file = join(dir, `${category}.toon`);
    const fields = SCHEMAS[category] || SCHEMAS.other;
    const key = `${currentDate}:${category}`;

    // Write TOON header if first write to this file today
    if (!headerWritten.has(key)) {
      // Check if file exists (might be from previous session same day)
      try {
        await stat(file);
        headerWritten.add(key); // File exists, assume header present
      } catch {
        // File doesn't exist, write header
        const header = `events{${fields.join(",")}}:\n`;
        await appendFile(file, header);
        headerWritten.add(key);
      }
    }

    // Write CSV values line
    const line = toCSVLine(fields, event) + "\n";
    await appendFile(file, line);
  } catch { /* best effort */ }
}

// ============================================================================
// Logger API
// ============================================================================

export const logger = {
    /** Get current log directory path */
  getLogPath: () => currentDir || join(LOG_DIR, getDateStr()),
  tool: (event: { tool: string; ok: boolean; ms: number; ch: number; raw?: number; err?: string }) => {
    const category = TOOL_CATEGORY[event.tool] || "other";
    writeToCategory(category, {
      ts: getTimeStr(),
      tool: event.tool,
      ok: event.ok ? 1 : 0,
      ms: event.ms,
      ch: event.ch,
      raw: event.raw,
      err: event.err,
    });
  },

  /** Log info event */
  info: (message: string) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "INFO",
    msg: message,
  }),

  /** Log warning event */
  warn: (message: string) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "WARN",
    msg: message,
  }),

  /** Log error event */
  error: (message: string, error?: unknown) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "ERROR",
    msg: message,
    err: error instanceof Error ? error.message : String(error ?? ""),
  }),

  /** Log startup */
  startup: (version: string, transport: string) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "INFO",
    msg: `MCX ${version} started (${transport})`,
  }),

  /** Log shutdown */
  shutdown: (reason: string) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "INFO",
    msg: `Shutdown: ${reason}`,
  }),

  /** Log uncaught exception */
  uncaughtException: (error: unknown) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "ERROR",
    msg: "Uncaught exception",
    err: error instanceof Error ? error.stack || error.message : String(error),
  }),

  /** Log unhandled rejection */
  unhandledRejection: (reason: unknown) => writeToCategory("session", {
    ts: getTimeStr(),
    level: "ERROR",
    msg: "Unhandled rejection",
    err: reason instanceof Error ? reason.stack || reason.message : String(reason),
  }),
};
