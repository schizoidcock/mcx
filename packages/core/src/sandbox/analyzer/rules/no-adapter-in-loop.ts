/**
 * Rule: no-adapter-in-loop
 *
 * Warns when adapter methods are called inside loops.
 * This can cause rate limiting issues or excessive API calls.
 *
 * Detects:
 * - for/while loops with adapter calls
 * - Array methods like .forEach, .map with adapter calls
 */

import type * as acorn from "acorn";
import type { Rule } from "../types.js";

// Loop types for reference (used in rule.visits)
// const LOOP_TYPES = ["WhileStatement", "ForStatement", "ForInStatement", "ForOfStatement", "DoWhileStatement"];

const ARRAY_LOOP_METHODS = new Set([
  "forEach",
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "flatMap",
]);

/**
 * Check if a member expression matches `adapters.X.Y` or `adapterName.method`
 */
function isAdapterCall(node: acorn.Node): { isAdapter: boolean; name?: string } {
  if (node.type !== "CallExpression") {
    return { isAdapter: false };
  }

  const callExpr = node as acorn.CallExpression;
  if (callExpr.callee.type !== "MemberExpression") {
    return { isAdapter: false };
  }

  const memberExpr = callExpr.callee as acorn.MemberExpression;

  // Check for `adapters.X.method()` pattern
  if (memberExpr.object.type === "MemberExpression") {
    const outerMember = memberExpr.object as acorn.MemberExpression;
    if (
      outerMember.object.type === "Identifier" &&
      (outerMember.object as acorn.Identifier).name === "adapters"
    ) {
      const adapterName =
        outerMember.property.type === "Identifier"
          ? (outerMember.property as acorn.Identifier).name
          : "unknown";
      return { isAdapter: true, name: adapterName };
    }
  }

  // Check for direct adapter name pattern (adapter injected as global)
  // e.g., `stripe.listCustomers()`
  if (memberExpr.object.type === "Identifier") {
    const objName = (memberExpr.object as acorn.Identifier).name;
    // Common adapter-like patterns (could be expanded)
    if (
      objName !== "console" &&
      objName !== "Math" &&
      objName !== "JSON" &&
      objName !== "Object" &&
      objName !== "Array" &&
      objName !== "String" &&
      objName !== "Number" &&
      objName !== "Promise" &&
      objName !== "Date" &&
      !objName.startsWith("_")
    ) {
      // This is heuristic - might be an adapter
      return { isAdapter: false }; // Don't flag, too many false positives
    }
  }

  return { isAdapter: false };
}

/**
 * Recursively find adapter calls in a node
 */
function findAdapterCalls(
  node: acorn.Node,
  results: Array<{ name: string; node: acorn.Node }>
): void {
  const check = isAdapterCall(node);
  if (check.isAdapter) {
    results.push({ name: check.name || "unknown", node });
  }

  // Don't descend into function definitions (they might not be called in loop)
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    // But DO check arrow functions that are callbacks to array methods
    // This is handled by the array method detection
    if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
      const fn = node as acorn.ArrowFunctionExpression;
      if (fn.body) {
        findAdapterCalls(fn.body, results);
      }
    }
    return;
  }

  // Check children
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            findAdapterCalls(item as acorn.Node, results);
          }
        }
      } else if ("type" in child) {
        findAdapterCalls(child as acorn.Node, results);
      }
    }
  }
}

/**
 * Check if a call expression is an array loop method
 */
function isArrayLoopMethod(node: acorn.Node): boolean {
  if (node.type !== "CallExpression") return false;

  const callExpr = node as acorn.CallExpression;
  if (callExpr.callee.type !== "MemberExpression") return false;

  const memberExpr = callExpr.callee as acorn.MemberExpression;
  if (memberExpr.property.type !== "Identifier") return false;

  const methodName = (memberExpr.property as acorn.Identifier).name;
  return ARRAY_LOOP_METHODS.has(methodName);
}

export const rule: Rule = {
  name: "no-adapter-in-loop",
  severity: "warn",
  description: "Warn when adapter methods are called inside loops",
  visits: [
    "WhileStatement",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "DoWhileStatement",
    "CallExpression",
  ],

  visitors: {
    WhileStatement(node, context) {
      checkLoopBody((node as acorn.WhileStatement).body, context, node);
    },
    ForStatement(node, context) {
      checkLoopBody((node as acorn.ForStatement).body, context, node);
    },
    ForInStatement(node, context) {
      checkLoopBody((node as acorn.ForInStatement).body, context, node);
    },
    ForOfStatement(node, context) {
      checkLoopBody((node as acorn.ForOfStatement).body, context, node);
    },
    DoWhileStatement(node, context) {
      checkLoopBody((node as acorn.DoWhileStatement).body, context, node);
    },
    CallExpression(node, context) {
      // Check for array methods like .forEach, .map with adapter calls
      if (!isArrayLoopMethod(node)) return;

      const callExpr = node as acorn.CallExpression;
      const callback = callExpr.arguments[0];
      if (!callback) return;

      const adapterCalls: Array<{ name: string; node: acorn.Node }> = [];
      findAdapterCalls(callback, adapterCalls);

      if (adapterCalls.length > 0) {
        const names = [...new Set(adapterCalls.map((c) => c.name))].join(", ");
        context.report({
          severity: "warn",
          message: `Adapter call (${names}) inside array iteration - may cause rate limiting`,
          line: context.getLine(node),
        });
      }
    },
  },
};

function checkLoopBody(
  body: acorn.Node,
  context: Parameters<Rule["visitors"][string]>[1],
  loopNode: acorn.Node
) {
  const adapterCalls: Array<{ name: string; node: acorn.Node }> = [];
  findAdapterCalls(body, adapterCalls);

  if (adapterCalls.length > 0) {
    const names = [...new Set(adapterCalls.map((c) => c.name))].join(", ");
    context.report({
      severity: "warn",
      message: `Adapter call (${names}) inside loop - may cause rate limiting`,
      line: context.getLine(loopNode),
    });
  }
}
