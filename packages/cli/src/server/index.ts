/**
 * MCP Server Module
 *
 * Centralizes server creation and transports.
 */

// Types
export type { Skill, Adapter, AdapterMethod, MCXConfig } from "./factory.js";
export type { ServerState, BackgroundTask, ServerStats } from "../context/state.js";
export type { FinderCache, McpResult } from "../utils/finder.js";

// Server creation
export { createMcxServer, loadEnvFile } from "./factory.js";
export { createMcxServerCore } from "./core.js";

// State management (from context/)
export { createServerState, trackTokenOutput, trackNetworkBytes, trackFsBytes } from "../context/state.js";
export { formatBytes, formatTaskDuration, generateTaskId, cleanupOldTasks } from "../context/state.js";

// Finder management (from utils/)
export { createFinderCache, withFinder, destroyFinderCache } from "../utils/finder.js";

// Transports
export { startDaemonServer } from "./http.js";
export { runStdio } from "./stdio.js";
