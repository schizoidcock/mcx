/**
 * Rule: no-unhandled-async
 *
 * Warns about async functions in array methods without proper handling:
 * - arr.map(async ...) without Promise.all
 * - arr.forEach(async ...) where promises are lost
 */

import type * as acorn from "acorn";
import type { Rule } from "../types.js";

/**
 * Check if a function is async
 */
function isAsyncFunction(node: acorn.Node): boolean {
  if (node.type === "ArrowFunctionExpression") {
    return (node as acorn.ArrowFunctionExpression).async;
  }
  if (node.type === "FunctionExpression") {
    return (node as acorn.FunctionExpression).async;
  }
  return false;
}

// Note: Checking if wrapped in Promise.all would require ancestor tracking
// which adds complexity. For now we warn on all async map() calls.

/**
 * Check if a call is to a problematic array method
 */
function getArrayMethodInfo(
  node: acorn.Node
): { method: string; isProblematic: boolean } | null {
  if (node.type !== "CallExpression") return null;

  const callExpr = node as acorn.CallExpression;
  if (callExpr.callee.type !== "MemberExpression") return null;

  const memberExpr = callExpr.callee as acorn.MemberExpression;
  if (memberExpr.property.type !== "Identifier") return null;

  const methodName = (memberExpr.property as acorn.Identifier).name;

  // forEach with async is always problematic (promises are lost)
  if (methodName === "forEach") {
    return { method: methodName, isProblematic: true };
  }

  // map with async needs Promise.all
  if (methodName === "map") {
    return { method: methodName, isProblematic: false };
  }

  // filter, find, etc. with async are problematic (won't work as expected)
  if (["filter", "find", "findIndex", "some", "every"].includes(methodName)) {
    return { method: methodName, isProblematic: true };
  }

  return null;
}

export const rule: Rule = {
  name: "no-unhandled-async",
  severity: "warn",
  description: "Warn about async functions in array methods without proper handling",
  visits: ["CallExpression"],

  visitors: {
    CallExpression(node, context) {
      const methodInfo = getArrayMethodInfo(node);
      if (!methodInfo) return;

      const callExpr = node as acorn.CallExpression;
      const callback = callExpr.arguments[0];
      if (!callback || !isAsyncFunction(callback)) return;

      if (methodInfo.method === "forEach") {
        context.report({
          severity: "warn",
          message:
            "async function in forEach() - promises are not awaited. Use for...of with await instead",
          line: context.getLine(node),
        });
        return;
      }

      if (methodInfo.method === "map") {
        // Check if wrapped in Promise.all - we need to track ancestors
        // For now, we'll use a simple heuristic: check if the result is being used
        // This is imperfect but catches common cases

        // Report warning - user should ensure Promise.all is used
        context.report({
          severity: "warn",
          message:
            "async function in map() - ensure result is wrapped with Promise.all() or await Promise.all()",
          line: context.getLine(node),
        });
        return;
      }

      if (methodInfo.isProblematic) {
        context.report({
          severity: "warn",
          message: `async function in ${methodInfo.method}() - async callbacks don't work as expected here`,
          line: context.getLine(node),
        });
      }
    },
  },
};
