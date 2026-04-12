/**
 * Tool Context & Types
 * 
 * Shared context passed to all MCP tool handlers.
 * Extracted from serve.ts to enable modular tool definitions.
 */

import type { FileFinder } from "@ff-labs/fff-bun";
import type { ContentStore } from "../search/store.js";
import type { BunWorkerSandbox } from "@papicandela/mcx-core";

// ============================================================================
// Background Tasks
// ============================================================================

export interface BackgroundTask {
  id: string;
  label?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
  logs: string[];
}

// ============================================================================
// Session State
// ============================================================================

export interface SessionVariables {
  /** Named variables stored via storeAs parameter */
  stored: Map<string, StoredVariable>;
  /** Last execution result ($result) */
  lastResult: unknown;
}

export interface StoredVariable {
  value: unknown;
  type: "file" | "result" | "search";
  path?: string;           // For file variables
  timestamp: number;
  lineCount?: number;      // For file variables
}

export interface SessionWorkflow {
  /** Recent tool calls for suggestions */
  lastTools: Array<{
    tool: string;
    file?: string;
    timestamp: number;
  }>;
  /** Proximity context for search boosting */
  proximityContext: {
    recentFiles: string[];
    recentPatterns: string[];
  };
}

// ============================================================================
// Tool Context
// ============================================================================

export interface ToolContext {
  /** FTS5 content store for indexing and search */
  contentStore: ContentStore;
  
  /** Sandbox for code execution */
  sandbox: BunWorkerSandbox;
  
  /** File finder instance (lazy initialized) */
  finder: FileFinder | null;
  
  /** Cached adapter spec for search */
  spec: AdapterSpec | null;
  
  /** Session variables ($result, $stored, etc.) */
  variables: SessionVariables;
  
  /** Workflow tracking for suggestions */
  workflow: SessionWorkflow;
  
  /** Multi-project watchers */
  watchedProjects: Map<string, FileFinder>;
  
  /** Background tasks (mcx_tasks) */
  backgroundTasks: Map<string, BackgroundTask>;
  
  /** Base path for FFF */
  basePath: string;
  
  /** File helpers code (injected into sandbox) */
  fileHelpersCode: string;
}

// ============================================================================
// Adapter Spec (for search)
// ============================================================================

export interface AdapterSpec {
  adapters: Record<string, AdapterDef>;
  skills: Record<string, SkillDef>;
}

export interface AdapterDef {
  name: string;
  domain?: string;
  description?: string;
  tools: Record<string, ToolDef>;
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, ParamDef>;
}

export interface ParamDef {
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface SkillDef {
  name: string;
  description?: string;
  parameters?: Record<string, ParamDef>;
}

// ============================================================================
// Tool Handler
// ============================================================================

export type McpResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

export type ToolHandler<P = Record<string, unknown>> = (
  ctx: ToolContext,
  params: P
) => Promise<McpResult>;

// ============================================================================
// Tool Definition
// ============================================================================

export interface ToolDefinition<P = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler<P>;
  /** If true, handler needs FileFinder - registration will wrap with withFinder */
  needsFinder?: boolean;
}

// ============================================================================
// Helper Types
// ============================================================================

/** Result from file operations */
export interface FileResult {
  path: string;
  content?: string;
  lines?: string[];
  lineCount: number;
  truncated?: boolean;
}

/** Result from search operations */
export interface SearchResult {
  source: string;
  section: string;
  snippet: string;
  score: number;
}

/** Result from grep operations */
export interface GrepResult {
  file: string;
  line: number;
  content: string;
  context?: {
    before: string[];
    after: string[];
  };
}

// ============================================================================
// Utility Functions (to be implemented)
// ============================================================================

export function createEmptyContext(): Partial<ToolContext> {
  return {
    variables: {
      stored: new Map(),
      lastResult: undefined,
    },
    workflow: {
      lastTools: [],
      proximityContext: {
        recentFiles: [],
        recentPatterns: [],
      },
    },
    watchedProjects: new Map(),
    backgroundTasks: new Map(),
  };
}
