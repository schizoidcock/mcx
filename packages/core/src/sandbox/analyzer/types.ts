/**
 * Types for the Pre-execution Analyzer
 */

import type * as acorn from "acorn";

/**
 * Severity levels for analysis results
 */
export type Severity = "warn" | "error";

/**
 * A single analysis finding
 */
export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  line?: number;
  column?: number;
}

/**
 * Result of analyzing code
 */
export interface AnalysisResult {
  /** Findings that should warn but not block */
  warnings: Finding[];
  /** Findings that should block execution */
  errors: Finding[];
  /** Time taken to analyze in ms */
  elapsed: number;
}

/**
 * Context passed to rule visitors
 */
export interface RuleContext {
  /** Report a finding */
  report: (finding: Omit<Finding, "rule">) => void;
  /** The source code being analyzed */
  code: string;
  /** Get the line number for a node */
  getLine: (node: acorn.Node) => number;
}

/**
 * A visitor function for a specific AST node type
 */
export type NodeVisitor = (node: acorn.Node, context: RuleContext) => void;

/**
 * Rule definition
 */
export interface Rule {
  /** Rule identifier */
  name: string;
  /** Severity when triggered */
  severity: Severity;
  /** Human-readable description */
  description: string;
  /** AST node types this rule visits (for performance) */
  visits: string[];
  /** Visitor functions keyed by node type */
  visitors: Record<string, NodeVisitor>;
}

/**
 * Analysis configuration
 */
export interface AnalysisConfig {
  /** Enable/disable analysis (default: true) */
  enabled?: boolean;
  /** Block execution on errors (default: true) */
  blockOnError?: boolean;
  /** Override severity for specific rules */
  rules?: Record<string, Severity | "off">;
}

/**
 * Default analysis configuration
 */
export const DEFAULT_ANALYSIS_CONFIG: Required<AnalysisConfig> = {
  enabled: true,
  blockOnError: true,
  rules: {},
};
