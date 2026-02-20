import type { z } from "zod";

/**
 * Configuration for an adapter method parameter
 */
export interface AdapterMethodParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Configuration for an adapter method
 */
export interface AdapterMethodConfig {
  name: string;
  description?: string;
  parameters?: AdapterMethodParameter[];
  handler: (...args: unknown[]) => unknown | Promise<unknown>;
}

/**
 * A method exposed by an adapter
 */
export interface AdapterMethod {
  name: string;
  description?: string;
  parameters: AdapterMethodParameter[];
  execute: (...args: unknown[]) => unknown | Promise<unknown>;
}

/**
 * Configuration for defining an adapter
 */
export interface AdapterConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description?: string;
  version?: string;
  configSchema?: TSchema;
  methods: AdapterMethodConfig[];
}

/**
 * A registered adapter instance
 */
export interface Adapter {
  name: string;
  description?: string;
  version: string;
  methods: Map<string, AdapterMethod>;
  config?: unknown;
}

/**
 * Configuration for the sandbox execution environment
 */
export interface SandboxConfig {
  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
  /** Memory limit in MB (default: 128) */
  memoryLimit?: number;
  /** Whether to allow async/await (default: true) */
  allowAsync?: boolean;
  /** Custom global variables to inject */
  globals?: Record<string, unknown>;
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
}

/**
 * Context passed to sandbox execution
 */
export interface ExecutionContext {
  /** Registered adapters accessible in sandbox */
  adapters: Record<string, Record<string, (...args: unknown[]) => unknown | Promise<unknown>>>;
  /** Custom variables */
  variables?: Record<string, unknown>;
}
