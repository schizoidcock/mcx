/**
 * Pre-execution Analyzer for MCX Sandbox
 *
 * @example
 * ```ts
 * import { analyze, formatFindings } from "./analyzer";
 *
 * const result = analyze(code);
 * if (result.errors.length > 0) {
 *   console.error("Blocked:", formatFindings(result.errors));
 * }
 * if (result.warnings.length > 0) {
 *   console.warn("Warnings:", formatFindings(result.warnings));
 * }
 * ```
 */

export {
  analyze,
  formatFindings,
  DEFAULT_ANALYSIS_CONFIG,
  type Rule,
  type Finding,
  type AnalysisResult,
  type AnalysisConfig,
  type RuleContext,
} from "./analyzer.js";

// Re-export rules for extensibility
export { allRules } from "./rules/index.js";
