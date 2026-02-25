/**
 * Rule: no-nested-loops
 *
 * Warns about nested loops which may indicate O(n²) complexity.
 * This is a heuristic - not all nested loops are bad, but worth flagging.
 */

import type * as acorn from "acorn";
import type { Rule } from "../types.js";

const LOOP_TYPES = new Set([
  "WhileStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "DoWhileStatement",
]);

/**
 * Check if a node contains a loop (at any depth, excluding function boundaries)
 */
function containsLoop(node: acorn.Node): { found: boolean; type?: string } {
  if (LOOP_TYPES.has(node.type)) {
    return { found: true, type: node.type };
  }

  // Don't descend into function definitions (they have their own scope)
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return { found: false };
  }

  // Check children
  for (const key of Object.keys(node)) {
    const child = (node as unknown as Record<string, unknown>)[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === "object" && "type" in item) {
            const result = containsLoop(item as acorn.Node);
            if (result.found) return result;
          }
        }
      } else if ("type" in child) {
        const result = containsLoop(child as acorn.Node);
        if (result.found) return result;
      }
    }
  }

  return { found: false };
}

/**
 * Get the body of a loop node
 */
function getLoopBody(node: acorn.Node): acorn.Node | null {
  switch (node.type) {
    case "WhileStatement":
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "DoWhileStatement":
      return (node as acorn.WhileStatement).body;
    default:
      return null;
  }
}

export const rule: Rule = {
  name: "no-nested-loops",
  severity: "warn",
  description: "Warn about nested loops (potential O(n²) complexity)",
  visits: ["WhileStatement", "ForStatement", "ForInStatement", "ForOfStatement", "DoWhileStatement"],

  visitors: {
    WhileStatement(node, context) {
      checkNestedLoop(node, context);
    },
    ForStatement(node, context) {
      checkNestedLoop(node, context);
    },
    ForInStatement(node, context) {
      checkNestedLoop(node, context);
    },
    ForOfStatement(node, context) {
      checkNestedLoop(node, context);
    },
    DoWhileStatement(node, context) {
      checkNestedLoop(node, context);
    },
  },
};

function checkNestedLoop(node: acorn.Node, context: Parameters<Rule["visitors"][string]>[1]) {
  const body = getLoopBody(node);
  if (!body) return;

  const inner = containsLoop(body);
  if (inner.found) {
    const outerType = node.type.replace("Statement", "").toLowerCase();
    const innerType = inner.type?.replace("Statement", "").toLowerCase() || "loop";

    context.report({
      severity: "warn",
      message: `Nested loops detected (${outerType} > ${innerType}) - potential O(n²) complexity`,
      line: context.getLine(node),
    });
  }
}
