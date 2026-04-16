/**
 * Daemon Lock File Operations
 *
 * Lock file is THE source of truth for daemon state.
 * All functions use early returns, max 3 indentation levels.
 */

import { readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getMcxHomeDir } from "../utils/paths.js";
import type { DaemonLock } from "./types.js";

const LOCK_FILE = "daemon.lock";

/** Get lock file path */
export function getLockPath(): string {
  return join(getMcxHomeDir(), LOCK_FILE);
}

/** Read lock file. Returns null if not exists or invalid. */
export function readLock(): DaemonLock | null {
  try {
    const content = readFileSync(getLockPath(), "utf8");
    const lock = JSON.parse(content);
    if (!lock.pid || !lock.port || !lock.startedAt) return null;
    return lock as DaemonLock;
  } catch {
    return null;
  }
}

/** Write lock file atomically using rename */
export function writeLock(lock: DaemonLock): void {
  const lockPath = getLockPath();
  const tmpPath = `${lockPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(lock), { mode: 0o644 });
  renameSync(tmpPath, lockPath);
}

/** Delete lock file */
export function deleteLock(): void {
  try {
    unlinkSync(getLockPath());
  } catch {
    // Ignore - file may not exist
  }
}

/** Check if process is alive using signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if daemon at lock is alive via HTTP health check */
export async function isDaemonAlive(lock: DaemonLock): Promise<boolean> {
  if (!isProcessAlive(lock.pid)) return false;

  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
