/**
 * Periodic Cleanup Coordinator
 * 
 * Calls cleanup functions from all modules that have growing data.
 * Called from register.ts every N tool calls.
 * 
 * Sources of truth:
 * - context/files.ts -> file tracking
 * - context/variables.ts -> session variables
 * - context/state.ts -> background tasks
 * - context/store.ts -> FTS5 content index
 */

import { cleanup as cleanupFiles } from "./files.js";
import { compressStale } from "./variables.js";
import { cleanupOldTasks, type BackgroundTask } from "./state.js";
import { cleanupStaleContent } from "./store.js";
import { CLEANUP_INTERVAL, MAP_TTL_MS } from "../tools/constants.js";

import { createDebugger } from "../utils/debug.js";

const debug = createDebugger("cleanup");

// ============================================================================
// State
// ============================================================================

let callCount = 0;

// ============================================================================
// Main Function
// ============================================================================

/**
 * Run periodic cleanup if needed.
 * Pass backgroundTasks to also clean stale tasks.
 */
export function runPeriodicCleanup(backgroundTasks?: Map<string, BackgroundTask>): number {
  callCount++;
  if (callCount < CLEANUP_INTERVAL) return 0;
  
  callCount = 0;
  
  const filesRemoved = cleanupFiles(MAP_TTL_MS);
  const varsCompressed = compressStale(MAP_TTL_MS).length;
  const tasksRemoved = backgroundTasks ? cleanupOldTasks(backgroundTasks, MAP_TTL_MS) : 0;
  const contentRemoved = cleanupStaleContent(MAP_TTL_MS);
  
  return filesRemoved + varsCompressed + tasksRemoved + contentRemoved;
}

/**
 * Force cleanup regardless of interval (for testing/shutdown)
 */
export function forceCleanup(backgroundTasks?: Map<string, BackgroundTask>): number {
  callCount = 0;
  const filesRemoved = cleanupFiles(MAP_TTL_MS);
  const varsCompressed = compressStale(MAP_TTL_MS).length;
  const tasksRemoved = backgroundTasks ? cleanupOldTasks(backgroundTasks, MAP_TTL_MS) : 0;
  const contentRemoved = cleanupStaleContent(MAP_TTL_MS);
  return filesRemoved + varsCompressed + tasksRemoved + contentRemoved;
}

/**
 * Get current call count (for stats)
 */
export function getCallCount(): number {
  return callCount;
}
