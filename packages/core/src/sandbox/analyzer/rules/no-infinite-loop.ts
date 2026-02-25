/**
 * Rule: no-infinite-loop
 *
 * Detects infinite loops without break statements:
 * - while(true) { ... } without break
 * - for(;;) { ... } without break
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
 * Check if a block contains a break statement (at any depth)
 */
function hasBreak(node: acorn.Node): boolean {
  if (node.type === "BreakStatement") return true;

  // Don't descend into nested loops or switches (break would apply to them)
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

  // Check children
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            if (hasBreak(item as acorn.Node)) return true;
          }
        }
      } else if ("type" in child) {
        if (hasBreak(child as acorn.Node)) return true;
      }
    }
  }

  return false;
}

export const rule: Rule = {
  name: "no-infinite-loop",
  severity: "error",
  description: "Disallow infinite loops without break statements",
  visits: ["WhileStatement", "ForStatement"],

  visitors: {
    WhileStatement(node, context) {
      const whileNode = node as acorn.WhileStatement;

      if (isLiteralTrue(whileNode.test) && !hasBreak(whileNode.body)) {
        context.report({
          severity: "error",
          message: "Infinite loop: while(true) without break",
          line: context.getLine(node),
        });
      }
    },

    ForStatement(node, context) {
      const forNode = node as acorn.ForStatement;

      // for(;;) without test condition
      if (!forNode.test && !hasBreak(forNode.body)) {
        context.report({
          severity: "error",
          message: "Infinite loop: for(;;) without break",
          line: context.getLine(node),
        });
      }
    },
  },
};
