/**
 * Rule: no-infinite-loop
 *
 * Detects infinite loops without exit statements:
 * - while(true) { ... } without break/return/throw
 * - for(;;) { ... } without break/return/throw
 * - do { ... } while(true) without break/return/throw
 */

import type * as acorn from "acorn";
import type { Rule } from "../types.js";

/**
 * Check if a node is a literal `true`
 */
function isLiteralTrue(node: acorn.Node | null | undefined): boolean {
  if (!node) return false;
  return node.type === "Literal" && (node as acorn.Literal).value === true;
}

/**
 * Check if a block contains an exit statement (break, return, throw)
 * These all terminate or exit the loop, so they prevent infinite loops.
 */
function hasExitStatement(node: acorn.Node): boolean {
  // Exit statements
  if (node.type === "BreakStatement") return true;
  if (node.type === "ReturnStatement") return true;
  if (node.type === "ThrowStatement") return true;

  // Don't descend into nested loops or switches (break would apply to them)
  // But DO descend for return/throw since they exit the function entirely
  if (
    node.type === "WhileStatement" ||
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement" ||
    node.type === "DoWhileStatement" ||
    node.type === "SwitchStatement"
  ) {
    return false;
  }

  // Don't descend into nested functions (return/throw would apply to them)
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return false;
  }

  // Check children
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            if (hasExitStatement(item as acorn.Node)) return true;
          }
        }
      } else if ("type" in child) {
        if (hasExitStatement(child as acorn.Node)) return true;
      }
    }
  }

  return false;
}

export const rule: Rule = {
  name: "no-infinite-loop",
  severity: "error",
  description: "Disallow infinite loops without exit statements",
  visits: ["WhileStatement", "ForStatement", "DoWhileStatement"],

  visitors: {
    WhileStatement(node, context) {
      const whileNode = node as acorn.WhileStatement;

      if (isLiteralTrue(whileNode.test) && !hasExitStatement(whileNode.body)) {
        context.report({
          severity: "error",
          message: "Infinite loop: while(true) without break/return/throw",
          line: context.getLine(node),
        });
      }
    },

    ForStatement(node, context) {
      const forNode = node as acorn.ForStatement;

      // for(;;) without test condition
      if (!forNode.test && !hasExitStatement(forNode.body)) {
        context.report({
          severity: "error",
          message: "Infinite loop: for(;;) without break/return/throw",
          line: context.getLine(node),
        });
      }
    },

    DoWhileStatement(node, context) {
      const doWhileNode = node as acorn.DoWhileStatement;

      if (isLiteralTrue(doWhileNode.test) && !hasExitStatement(doWhileNode.body)) {
        context.report({
          severity: "error",
          message: "Infinite loop: do...while(true) without break/return/throw",
          line: context.getLine(node),
        });
      }
    },
  },
};
