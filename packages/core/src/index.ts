/**
 * @mcx/core - MCX Framework Core
 *
 * Provides the core functionality for the MCX (MCP Code eXecution) framework:
 * - Sandboxed code execution using isolated-vm
 * - Adapter system for extending sandbox capabilities
 * - Skill system for reusable code snippets
 * - Configuration management
 *
 * @packageDocumentation
 */

// Types
export type {
  Adapter,
  AdapterConfig,
  AdapterMethod,
  AdapterMethodConfig,
  AdapterMethodParameter,
  ExecutionContext,
  MCXConfig,
  SandboxConfig,
  SandboxResult,
  Skill,
  SkillConfig,
} from "./types.js";

// Sandbox
export type { ISandbox, SandboxFactory } from "./sandbox/interface.js";
export { BunWorkerSandbox, createSandbox } from "./sandbox/bun-worker.js";

// Adapter
export {
  createAdapterFactory,
  defineAdapter,
  type InferAdapterConfig,
} from "./adapter.js";

// Skill
export { defineSkill, defineSkills, skillBuilder } from "./skill.js";

// Config
export { configBuilder, defineConfig, mergeConfigs } from "./config.js";

// Executor
export {
  createExecutor,
  MCXExecutor,
  type ExecutorOptions,
} from "./executor.js";

// Re-export zod for convenience
export { z } from "zod";
