/**
 * Hybrid Output Filter System
 * 
 * Modular filter system for formatting command output.
 * - Declarative rules for common commands
 * - Specialized formatters for complex output
 */

// Types
export type { FilterRule, CompiledPatterns } from "./types.js";

// Rules
export { BUILTIN_FILTERS } from "./rules.js";

// Core functions
export { applyDeclarativeFilter, applyHybridFilter } from "./apply.js";

// Formatters
export {
  formatGitDiff,
  formatTestOutput,
  formatLintOutput,
  formatDockerLogs,
  formatLsOutput,
  formatJsonStructure,
  formatLogOutput,
  formatGhPrList,
  formatGhIssueList,
  formatGhRunList,
} from "./formatters.js";
