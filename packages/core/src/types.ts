import type { z } from "zod";

// ============================================================================
// Unified Adapter Types (compatible with @papicandela/mcx-adapters)
// ============================================================================

/**
 * Parameter definition for adapter tools
 */
export interface ParameterDefinition {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Adapter tool definition (unified interface)
 */
export interface AdapterTool<TParams = unknown, TResult = unknown> {
  description: string;
  parameters?: Record<string, ParameterDefinition>;
  execute: (params: TParams) => Promise<TResult> | TResult;
}

/**
 * A registered adapter instance (unified interface)
 *
 * This is the canonical adapter interface used throughout MCX.
 * Compatible with both core and adapters package.
 */
export interface Adapter<TTools extends Record<string, AdapterTool> = Record<string, AdapterTool>> {
  name: string;
  description?: string;
  version?: string;
  tools: TTools;
  dispose?: () => Promise<void> | void;
}

// ============================================================================
// Legacy Types (deprecated - use unified types above)
// ============================================================================

/**
 * @deprecated Use ParameterDefinition instead
 */
export interface AdapterMethodParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/**
 * @deprecated Use AdapterTool instead
 */
export interface AdapterMethodConfig {
  name: string;
  description?: string;
  parameters?: AdapterMethodParameter[];
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
}

/**
 * @deprecated Use AdapterTool instead
 */
export interface AdapterMethod {
  name: string;
  description?: string;
  parameters: AdapterMethodParameter[];
  execute: (...args: unknown[]) => unknown | Promise<unknown>;
}

/**
 * @deprecated Use Adapter with tools: Record<> instead
 */
export interface AdapterConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description?: string;
  version?: string;
  configSchema?: TSchema;
  methods: AdapterMethodConfig[];
}

/**
 * @deprecated Legacy adapter interface - use Adapter instead
 */
export interface LegacyAdapter {
  name: string;
  description?: string;
  version: string;
  methods: Map<string, AdapterMethod>;
  config?: unknown;
}

import type { NetworkPolicy } from "./sandbox/network-policy.js";
import type { AnalysisConfig } from "./sandbox/analyzer/index.js";

/**
 * Configuration for the sandbox execution environment.
 *
 * @example
 * ```ts
 * const config: SandboxConfig = {
 *   timeout: 10000,
 *   networkPolicy: { mode: 'blocked' },
 *   normalizeCode: true,
 *   analysis: {
 *     enabled: true,
 *     blockOnError: true,
 *     rules: { 'no-infinite-loop': 'error' }
 *   }
 * };
 * ```
 */
export interface SandboxConfig {
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Memory limit in MB (default: 128, not enforced in Bun Workers) */
  memoryLimit?: number;
  /** Whether to allow async/await (default: true) */
  allowAsync?: boolean;
  /** Custom global variables to inject into sandbox */
  globals?: Record<string, unknown>;
  /** Network access policy - blocked, allowed (whitelist), or unrestricted (default: blocked) */
  networkPolicy?: NetworkPolicy;
  /** Normalize code before execution - auto-add return, syntax validation (default: true) */
  normalizeCode?: boolean;
  /** Pre-execution analysis - detects infinite loops, dangerous patterns (default: enabled) */
  analysis?: AnalysisConfig;
}

/**
 * Result from sandbox code execution
 */
export interface SandboxResult<T = unknown> {
  success: boolean;
  value?: T;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  logs: string[];
  executionTime: number;
}

/**
 * Skill run function signature
 */
export type SkillRunFunction = (ctx: Record<string, unknown>) => Promise<unknown> | unknown;

/**
 * Configuration for defining a skill
 */
export interface SkillConfig {
  name: string;
  description?: string;
  version?: string;
  /** Required adapters for this skill */
  adapters?: string[];
  /** The skill code to execute (sandbox mode) */
  code?: string;
  /** Direct run function (native mode) */
  run?: SkillRunFunction;
  /** Sandbox configuration overrides */
  sandbox?: SandboxConfig;
}

/**
 * A registered skill instance
 */
export interface Skill {
  name: string;
  description?: string;
  version: string;
  adapters: string[];
  /** Code string for sandbox execution */
  code?: string;
  /** Direct run function for native execution */
  run?: SkillRunFunction;
  sandboxConfig: SandboxConfig;
}

/**
 * Main MCX framework configuration
 */
export interface MCXConfig {
  /** Adapters to load */
  adapters?: Adapter[];
  /** Skills to register */
  skills?: Skill[];
  /** Default sandbox configuration */
  sandbox?: SandboxConfig;
  /** Path to adapters directory */
  adaptersDir?: string;
  /** Path to skills directory */
  skillsDir?: string;
  /** Environment variables to inject into sandbox */
  env?: Record<string, string | undefined>;
}

/**
 * Context passed to sandbox execution
 */
export interface ExecutionContext {
  /** Registered adapters accessible in sandbox */
  adapters: Record<string, Record<string, (...args: unknown[]) => unknown | Promise<unknown>>>;
  /** Custom variables */
  variables?: Record<string, unknown>;
  /** Environment variables accessible in sandbox */
  env?: Record<string, string | undefined>;
}
