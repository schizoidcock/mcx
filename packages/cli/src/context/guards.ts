/**
 * Guards - Pattern enforcement
 * 
 * Detects and blocks problematic patterns:
 * - Retry loops (code that fails repeatedly)
 * - Lines hunting (overlapping ranges in lines())
 */

import { eventTips } from "./tips.js";

// ============================================================================
// Constants
// ============================================================================

const FAILURE_WINDOW_MS = 60_000;
const LINES_HUNT_THRESHOLD = 3;
const LINES_HUNT_WINDOW_MS = 60_000;

// ============================================================================
// Execute Failures (Retry Loop Detection)
// ============================================================================

interface FailureRecord {
  count: number;
  lastTime: number;
  lastError: string;
}

const executeFailures = new Map<string, FailureRecord>();

/** Hash code to signature */
export function getCodeSignature(code: string): string {
  return code.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Check if code is in retry loop - returns warning or null */
export function checkRetryLoop(sig: string): string | null {
  const prev = executeFailures.get(sig);
  if (!prev) return null;
  if (Date.now() - prev.lastTime > FAILURE_WINDOW_MS) return null;
  if (prev.count < 2) return null;
  return `⚠️ This code failed ${prev.count}x recently. Last: ${prev.lastError.slice(0, 100)}`;
}

/** Record a failure */
export function recordFailure(sig: string, error: string): void {
  const prev = executeFailures.get(sig) || { count: 0, lastTime: 0, lastError: '' };
  executeFailures.set(sig, {
    count: prev.count + 1,
    lastTime: Date.now(),
    lastError: error,
  });
}

/** Clear failure on success */
export function clearFailure(sig: string): void {
  executeFailures.delete(sig);
}

// ============================================================================
// Lines Hunting Detection
// ============================================================================

interface LinesTracker {
  count: number;
  lastRange: [number, number];
  timestamp: number;
}

const linesCallTracker = new Map<string, LinesTracker>();

export interface LinesCheckResult {
  blocked: boolean;
  tip: string | null;
}

/** Check for lines hunting pattern */
export function checkLinesHunting(varName: string, start: number, end: number): LinesCheckResult {
  const now = Date.now();
  const tracker = linesCallTracker.get(varName);
  
  // No tracker or expired
  if (!tracker || now - tracker.timestamp > LINES_HUNT_WINDOW_MS) {
    linesCallTracker.set(varName, { count: 1, lastRange: [start, end], timestamp: now });
    return { blocked: false, tip: null };
  }
  
  // Check overlap
  const [lastStart, lastEnd] = tracker.lastRange;
  const isOverlapping = start <= lastEnd + 50 && start >= lastStart - 50;
  
  if (!isOverlapping) {
    linesCallTracker.set(varName, { count: 1, lastRange: [start, end], timestamp: now });
    return { blocked: false, tip: null };
  }
  
  // Overlapping - increment
  tracker.count++;
  tracker.lastRange = [start, end];
  if (tracker.count >= LINES_HUNT_THRESHOLD) {
    linesCallTracker.delete(varName);
    return { blocked: true, tip: eventTips.linesHunting(varName, tracker.count) };
  }
  
  if (tracker.count === 2) {
    return { blocked: false, tip: eventTips.linesOverlap(varName) };
  }

  return { blocked: false, tip: null };
}

// ============================================================================
// Cleanup
// ============================================================================

// ============================================================================
// Search Throttle
// ============================================================================

import { THROTTLE_AFTER, BLOCK_AFTER, THROTTLE_WINDOW_MS } from "../tools/constants.js";

interface SearchThrottleState {
  count: number;
  windowStart: number;
}

const searchThrottle: SearchThrottleState = { count: 0, windowStart: Date.now() };

export interface ThrottleResult {
  calls: number;
  blocked: boolean;
  reducedLimit: boolean;
}

export function checkSearchThrottle(): ThrottleResult {
  const now = Date.now();
  if (now - searchThrottle.windowStart > THROTTLE_WINDOW_MS) {
    searchThrottle.count = 0;
    searchThrottle.windowStart = now;
  }
  searchThrottle.count++;
  return {
    calls: searchThrottle.count,
    blocked: searchThrottle.count > BLOCK_AFTER,
    reducedLimit: searchThrottle.count > THROTTLE_AFTER,
  };
}

// ============================================================================
// Cleanup
// ============================================================================

export function cleanupGuards(now = Date.now()): void {
  for (const [key, val] of executeFailures) {
    if (now - val.lastTime > FAILURE_WINDOW_MS) executeFailures.delete(key);
  }
  for (const [key, val] of linesCallTracker) {
    if (now - val.timestamp > LINES_HUNT_WINDOW_MS) linesCallTracker.delete(key);
  }
  // Reset search throttle if window expired
  if (now - searchThrottle.windowStart > THROTTLE_WINDOW_MS) {
    searchThrottle.count = 0;
    searchThrottle.windowStart = now;
  }
}
