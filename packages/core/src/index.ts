/**
 * @mcx/core - MCX Framework Core
 *
 * Provides the core functionality for the MCX (MCP Code eXecution) framework:
 * - Sandboxed code execution using Bun Workers
 * - Network isolation (blocked by default)
 * - Pre-execution code analysis (detects infinite loops, dangerous patterns)
 * - AST-based code normalization (auto-return, syntax validation)
 * - Adapter system for extending sandbox capabilities
 * - Skill system for reusable code snippets
 * - Type generation for LLM context
 * - Configuration management
 *
 * @packageDocumentation
 */

// Types (Unified)
export type {
  // New unified types
  Adapter,
  AdapterTool,
  ParameterDefinition,
  ExecutionContext,
  MCXConfig,
  SandboxConfig,
  SandboxResult,
  Skill,
  SkillConfig,
  // Legacy types (deprecated)
  AdapterConfig,
  AdapterMethod,
  AdapterMethodConfig,
  AdapterMethodParameter,
  LegacyAdapter,
} from "./types.js";

// Sandbox
export type { ISandbox, SandboxFactory } from "./sandbox/interface.js";
export { BunWorkerSandbox, createSandbox } from "./sandbox/bun-worker.js";
export {
  DEFAULT_NETWORK_POLICY,
  isUrlAllowed,
  type NetworkPolicy,
} from "./sandbox/network-policy.js";
export {
  normalizeCode,
  validateSyntax,
  checkDangerousPatterns,
  type NormalizerOptions,
  type NormalizerResult,
} from "./sandbox/normalizer.js";
export {
  analyze,
  formatFindings,
  DEFAULT_ANALYSIS_CONFIG,
  allRules,
  type Rule,
  type Finding,
  type AnalysisResult,
  type AnalysisConfig,
  type RuleContext,
} from "./sandbox/analyzer/index.js";

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

// Type Generator
export {
  generateTypes,
  generateTypesSummary,
  sanitizeIdentifier,
  type TypeGeneratorOptions,
} from "./type-generator.js";

// Executor
export {
  createExecutor,
  MCXExecutor,
  type ExecutorOptions,
} from "./executor.js";

// Re-export zod for convenience
export { z } from "zod";
