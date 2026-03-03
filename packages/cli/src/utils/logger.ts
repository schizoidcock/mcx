/**
 * File-based logger for MCX
 * Writes logs to ~/.mcx/logs/mcx.log with automatic rotation
 */

import { appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const LOG_DIR = join(homedir(), ".mcx", "logs");
export const LOG_FILE = join(LOG_DIR, "mcx.log");
const MAX_LOG_SIZE = 1024 * 1024; // 1MB
const MAX_OLD_LOGS = 3; // Keep mcx.log.1, mcx.log.2, mcx.log.3

/** Log levels as constants for type-safe matching */
export const LOG_LEVELS = {
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  DEBUG: "DEBUG",
} as const;

export type LogLevel = (typeof LOG_LEVELS)[keyof typeof LOG_LEVELS];

let initialized = false;
let bytesWrittenSinceCheck = 0;
const CHECK_ROTATION_EVERY_BYTES = 50000; // Check rotation every ~50KB written

async function ensureLogDir(): Promise<void> {
  if (initialized) return;
  try {
    await mkdir(LOG_DIR, { recursive: true });
    initialized = true;
  } catch {
    // Ignore - best effort logging
  }
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const stats = await stat(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return;

    // Rotate: mcx.log.2 -> mcx.log.3, mcx.log.1 -> mcx.log.2, mcx.log -> mcx.log.1
    for (let i = MAX_OLD_LOGS - 1; i >= 1; i--) {
      const older = `${LOG_FILE}.${i}`;
      const newer = `${LOG_FILE}.${i + 1}`;
      try {
        await rename(older, newer);
      } catch {
        // File doesn't exist, skip
      }
    }

    // mcx.log -> mcx.log.1
    await rename(LOG_FILE, `${LOG_FILE}.1`);

    // Delete oldest if exists
    try {
      await unlink(`${LOG_FILE}.${MAX_OLD_LOGS + 1}`);
    } catch {
      // Doesn't exist
    }
  } catch {
    // File doesn't exist yet or other error, ignore
  }
}

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }
  return String(error);
}

async function writeLog(level: LogLevel, message: string, error?: unknown): Promise<void> {
  await ensureLogDir();

  // Only check rotation periodically to avoid stat() on every write
  if (bytesWrittenSinceCheck >= CHECK_ROTATION_EVERY_BYTES) {
    await rotateIfNeeded();
    bytesWrittenSinceCheck = 0;
  }

  const timestamp = formatTimestamp();
  let line = `[${timestamp}] [${level}] ${message}`;
  if (error !== undefined) {
    line += `\n  ${formatError(error).replace(/\n/g, "\n  ")}`;
  }
  line += "\n";

  try {
    await appendFile(LOG_FILE, line);
    bytesWrittenSinceCheck += line.length;
  } catch {
    // Best effort - don't crash on log failure
  }
}

export const logger = {
  info: (message: string, error?: unknown) => writeLog("INFO", message, error),
  warn: (message: string, error?: unknown) => writeLog("WARN", message, error),
  error: (message: string, error?: unknown) => writeLog("ERROR", message, error),
  debug: (message: string, error?: unknown) => writeLog("DEBUG", message, error),

  /** Log process startup */
  startup: (version: string, transport: string) =>
    writeLog("INFO", `MCX started (v${version}, transport=${transport}, pid=${process.pid})`),

  /** Log process shutdown */
  shutdown: (reason: string) =>
    writeLog("INFO", `MCX shutdown: ${reason}`),

  /** Log uncaught exception */
  uncaughtException: (error: unknown) =>
    writeLog("ERROR", "Uncaught exception", error),

  /** Log unhandled rejection */
  unhandledRejection: (reason: unknown) =>
    writeLog("ERROR", "Unhandled rejection", reason),

  /** Get log file path */
  getLogPath: () => LOG_FILE,
};
