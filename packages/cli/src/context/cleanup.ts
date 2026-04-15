/**
 * Periodic Cleanup Coordinator
 * 
 * Calls cleanup functions from all modules that have growing Maps.
 * Called from register.ts every N tool calls.
 * 
 * ONE source of truth: sandbox/state.ts owns time Maps
 */

import { cleanup as cleanupFiles } from "./files.js";
import { getSandboxState } from "../sandbox/index.js";

// ============================================================================
// Config
// ============================================================================

const CLEANUP_INTERVAL = 50;  // Every N tool calls
const MAX_AGE_MS = 30 * 60 * 1000;  // 30 minutes

// ============================================================================
// State
// ============================================================================

let callCount = 0;

// ============================================================================
// Main Function
// ============================================================================

/**
 * Run periodic cleanup if needed.
 * Returns number of entries removed, or 0 if cleanup wasn't triggered.
 */
export function runPeriodicCleanup(): number {
  callCount++;
  if (callCount < CLEANUP_INTERVAL) return 0;
  
  callCount = 0;  // Reset counter
  
  // Run all cleanups (ONE source of truth: state owns time Maps)
  const filesRemoved = cleanupFiles(MAX_AGE_MS);
  const timeRemoved = getSandboxState().cleanupTimeMaps(MAX_AGE_MS);
  
  return filesRemoved + timeRemoved;
}

/**
 * Force cleanup regardless of interval (for testing/shutdown)
 */
export function forceCleanup(): number {
  callCount = 0;
  return cleanupFiles(MAX_AGE_MS) + getSandboxState().cleanupTimeMaps(MAX_AGE_MS);
}

/**
 * Get current call count (for stats)
 */
export function getCallCount(): number {
  return callCount;
}
