/**
 * Server State Management
 * 
 * Linus principles:
 * - Data structures over code
 * - Functions <20 lines
 * - No closures for state (explicit passing)
 */

import { MAX_BACKGROUND_TASKS, TASK_TTL_MS } from "../tools/constants.js";

// ============================================================================
// Types
// ============================================================================

export interface BackgroundTask {
  id: string;
  code: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  logs: string[];
}

export interface ServerStats {
  networkBytesIn: number;
  networkBytesOut: number;
  fsBytesRead: number;
  fsFilesRead: number;
  networkRequests: number;
  tokensOutput: number;
  executionCounter: number;
  toolUsage: Map<string, number>;
}

export interface ServerState {
  stats: ServerStats;
  backgroundTasks: Map<string, BackgroundTask>;
  taskIdCounter: number;
}

// ============================================================================
// Factory
// ============================================================================

export function createServerState(): ServerState {
  return {
    stats: {
      networkBytesIn: 0,
      networkBytesOut: 0,
      fsBytesRead: 0,
      fsFilesRead: 0,
      networkRequests: 0,
      tokensOutput: 0,
      executionCounter: 0,
      toolUsage: new Map(),
    },
    backgroundTasks: new Map(),
    taskIdCounter: 0,
  };
}

// ============================================================================
// Tracking Functions (pure, take state as param)
// ============================================================================

type MCP = { CallToolResult: { content: Array<{ type: string; text?: string }>; isError?: boolean } };

export function trackTokenOutput(
  state: ServerState,
  toolName: string,
  response: MCP["CallToolResult"],
  rawBytes?: number
): MCP["CallToolResult"] {
  state.stats.toolUsage.set(toolName, (state.stats.toolUsage.get(toolName) || 0) + 1);
  
  let bytes = 0;
  for (const item of response.content) {
    if (item.type === "text" && item.text) bytes += item.text.length;
  }
  state.stats.tokensOutput += rawBytes ?? bytes;
  return response;
}

export function trackNetworkBytes(state: ServerState, bytesIn: number, bytesOut = 0): void {
  state.stats.networkBytesIn += bytesIn;
  state.stats.networkBytesOut += bytesOut;
}

export function trackFsBytes(state: ServerState, bytes: number): void {
  state.stats.fsBytesRead += bytes;
}

export function trackSandboxIO(
  state: ServerState, 
  tracking?: { fsBytes: number; fsCount: number; netBytes: number; netCount: number }
): void {
  if (!tracking) return;
  state.stats.fsBytesRead += tracking.fsBytes;
  state.stats.fsFilesRead += tracking.fsCount;
  state.stats.networkBytesIn += tracking.netBytes;
  state.stats.networkRequests += tracking.netCount;
}

// ============================================================================
// Utility Functions
// ============================================================================

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}



export function generateTaskId(state: ServerState): string {
  state.taskIdCounter++;
  return `task_${state.taskIdCounter}`;
}

/** Remove tasks older than maxAge */
function removeStale(tasks: Map<string, BackgroundTask>, maxAgeMs: number): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, task] of tasks) {
    if (task.status === 'running') continue;
    if (now - (task.completedAt || task.startedAt) > maxAgeMs) {
      tasks.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Remove oldest completed tasks if over limit */
function removeOverLimit(tasks: Map<string, BackgroundTask>): number {
  if (tasks.size <= MAX_BACKGROUND_TASKS) return 0;
  
  const completed = [...tasks.entries()]
    .filter(([, t]) => t.status !== 'running')
    .sort((a, b) => (a[1].completedAt || 0) - (b[1].completedAt || 0));

  let removed = 0;
  while (tasks.size > MAX_BACKGROUND_TASKS && completed.length > 0) {
    tasks.delete(completed.shift()![0]);
    removed++;
  }
  return removed;
}

/** Cleanup old tasks by time AND count */
export function cleanupOldTasks(tasks: Map<string, BackgroundTask>, maxAgeMs = TASK_TTL_MS): number {
  return removeStale(tasks, maxAgeMs) + removeOverLimit(tasks);
}
