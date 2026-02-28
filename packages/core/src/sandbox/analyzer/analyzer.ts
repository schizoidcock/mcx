/**
 * Pre-execution Analyzer for MCX Sandbox
 *
 * Analyzes code before execution to detect potential issues:
 * - Infinite loops (while(true), for(;;) without break)
 * - Nested loops (O(n²) complexity warning)
 * - Adapter calls in loops (rate limiting risk)
 * - Unhandled async patterns (async in forEach/map)
 * - Dangerous globals (eval, require, process)
 *
 * Performance target: < 50ms for typical LLM-generated code (50-200 lines)
 *
 * @example
 * ```ts
 * import { analyze, formatFindings } from "./analyzer";
 *
 * const result = analyze(code);
 *
 * // Errors block execution
 * if (result.errors.length > 0) {
 *   return { success: false, error: formatFindings(result.errors)[0] };
 * }
 *
 * // Warnings go to logs
 * const logs = formatFindings(result.warnings);
 * ```
 */

import * as acorn from "acorn";
import type { Rule, Finding, AnalysisResult, AnalysisConfig, RuleContext } from "./types.js";
import { DEFAULT_ANALYSIS_CONFIG } from "./types.js";
import { allRules } from "./rules/index.js";

/**
 * Pre-indexed visitor map for O(1) rule lookup by node type
 */
type VisitorMap = Map<string, Array<{ rule: Rule; visitor: Rule["visitors"][string] }>>;

// Cache for visitor maps - keyed by stringified rules config (LRU with max 10 entries)
const CACHE_MAX_SIZE = 10;
const visitorMapCache = new Map<string, VisitorMap>();

/**
 * Get or build a visitor map (cached for performance with LRU eviction)
 */
function getVisitorMap(rules: Rule[], config: Required<AnalysisConfig>): VisitorMap {
  // Create cache key from rules config
  const cacheKey = JSON.stringify(config.rules);

  let map = visitorMapCache.get(cacheKey);
  if (map) {
    // Move to end for LRU (delete and re-add)
    visitorMapCache.delete(cacheKey);
    visitorMapCache.set(cacheKey, map);
    return map;
  }

  // Build new map
  map = buildVisitorMap(rules, config);

  // Evict oldest if at capacity
  if (visitorMapCache.size >= CACHE_MAX_SIZE) {
    const oldest = visitorMapCache.keys().next().value;
    if (oldest) visitorMapCache.delete(oldest);
  }

  visitorMapCache.set(cacheKey, map);
  return map;
}

/**
 * Build a visitor map from rules for efficient traversal
 */
function buildVisitorMap(rules: Rule[], config: Required<AnalysisConfig>): VisitorMap {
  const map: VisitorMap = new Map();

  for (const rule of rules) {
    // Check if rule is disabled
    const ruleConfig = config.rules[rule.name];
    if (ruleConfig === "off") continue;

    for (const nodeType of rule.visits) {
      const visitor = rule.visitors[nodeType];
      if (!visitor) continue;

      if (!map.has(nodeType)) {
        map.set(nodeType, []);
      }
      map.get(nodeType)!.push({ rule, visitor });
    }
  }

  return map;
}

/**
 * Get line number for a node position
 */
function getLineNumber(code: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position && i < code.length; i++) {
    if (code[i] === "\n") line++;
  }
  return line;
}

/**
 * Simple AST traversal
 */
function traverse(
  node: acorn.Node,
  visitorMap: VisitorMap,
  context: RuleContext,
  findings: Finding[]
): void {
  // Get visitors for this node type
  const visitors = visitorMap.get(node.type);
  if (visitors) {
    for (const { rule, visitor } of visitors) {
      // Create a context that captures findings for this rule
      const ruleContext: RuleContext = {
        ...context,
        report: (finding) => {
          findings.push({
            ...finding,
            rule: rule.name,
          });
        },
      };
      visitor(node, ruleContext);
    }
  }

  // Traverse children
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc") continue;

    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            traverse(item as acorn.Node, visitorMap, context, findings);
          }
        }
      } else if ("type" in child) {
        traverse(child as acorn.Node, visitorMap, context, findings);
      }
    }
  }
}

/**
 * Analyze code for potential issues
 *
 * @param code - The code to analyze
 * @param config - Analysis configuration
 * @returns Analysis result with warnings and errors
 */
export function analyze(
  code: string,
  config: Partial<AnalysisConfig> = {}
): AnalysisResult {
  const start = performance.now();
  const fullConfig: Required<AnalysisConfig> = {
    ...DEFAULT_ANALYSIS_CONFIG,
    ...config,
  };

  // If disabled, return empty result
  if (!fullConfig.enabled) {
    return {
      warnings: [],
      errors: [],
      elapsed: performance.now() - start,
    };
  }

  // Parse with acorn
  let ast: acorn.Program;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    // Parse error - normalizer should have caught this, skip analysis
    return {
      warnings: [],
      errors: [],
      elapsed: performance.now() - start,
    };
  }

  // Get visitor map (cached for repeated calls with same config)
  const visitorMap = getVisitorMap(allRules, fullConfig);

  // Create context
  const context: RuleContext = {
    code,
    getLine: (node) => getLineNumber(code, node.start),
    report: () => {}, // Will be overridden per-rule
  };

  // Traverse and collect findings
  const findings: Finding[] = [];
  traverse(ast, visitorMap, context, findings);

  // Apply severity overrides from config
  for (const finding of findings) {
    const override = fullConfig.rules[finding.rule];
    if (override && override !== "off") {
      finding.severity = override;
    }
  }

  // Separate warnings and errors
  const warnings = findings.filter((f) => f.severity === "warn");
  const errors = findings.filter((f) => f.severity === "error");

  const elapsed = performance.now() - start;

  // Log if we exceed performance budget (use stderr to avoid breaking stdio transport)
  if (elapsed > 50) {
    console.error(`[mcx-analyzer] Exceeded 50ms budget: ${elapsed.toFixed(1)}ms`);
  }

  return { warnings, errors, elapsed };
}

/**
 * Format findings as log messages
 */
export function formatFindings(findings: Finding[]): string[] {
  return findings.map((f) => {
    const prefix = f.severity === "error" ? "[ERROR]" : "[WARN]";
    const location = f.line ? ` (line ${f.line})` : "";
    return `${prefix} ${f.rule}${location}: ${f.message}`;
  });
}

// Re-export types
export type { Rule, Finding, AnalysisResult, AnalysisConfig, RuleContext } from "./types.js";
export { DEFAULT_ANALYSIS_CONFIG } from "./types.js";
