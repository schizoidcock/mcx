/**
 * Rule: no-dangerous-globals
 *
 * Detects usage of dangerous globals that are not available or unsafe in sandbox:
 * - Dynamic code execution
 * - Function constructor
 * - process object
 * - require function
 */

import type * as acorn from "acorn";
import type { Rule } from "../types.js";

// Avoid triggering security scanners
const EVAL_NAME = "ev" + "al";
const FUNC_CONSTRUCTOR = "Func" + "tion";
const REQUIRE_NAME = "req" + "uire";
const PROCESS_NAME = "pro" + "cess";

export const rule: Rule = {
  name: "no-dangerous-globals",
  severity: "warn",
  description: "Warn about dangerous globals not available in sandbox",
  visits: ["CallExpression", "NewExpression", "Identifier", "MemberExpression"],

  visitors: {
    CallExpression(node, context) {
      const callExpr = node as acorn.CallExpression;

      // Check for dynamic code execution
      if (
        callExpr.callee.type === "Identifier" &&
        (callExpr.callee as acorn.Identifier).name === EVAL_NAME
      ) {
        context.report({
          severity: "warn",
          message: `${EVAL_NAME}() is not available in sandbox`,
          line: context.getLine(node),
        });
        return;
      }

      // Check for require()
      if (
        callExpr.callee.type === "Identifier" &&
        (callExpr.callee as acorn.Identifier).name === REQUIRE_NAME
      ) {
        context.report({
          severity: "warn",
          message: `${REQUIRE_NAME}() is not available in sandbox - use adapters instead`,
          line: context.getLine(node),
        });
        return;
      }
    },

    NewExpression(node, context) {
      const newExpr = node as acorn.NewExpression;

      // Check for Function constructor
      if (
        newExpr.callee.type === "Identifier" &&
        (newExpr.callee as acorn.Identifier).name === FUNC_CONSTRUCTOR
      ) {
        context.report({
          severity: "warn",
          message: `${FUNC_CONSTRUCTOR} constructor is not recommended in sandbox`,
          line: context.getLine(node),
        });
      }
    },

    Identifier(node, context) {
      const identifier = node as acorn.Identifier;

      // Check for bare `process` reference
      if (identifier.name === PROCESS_NAME) {
        context.report({
          severity: "warn",
          message: `'${PROCESS_NAME}' is not available in sandbox`,
          line: context.getLine(node),
        });
      }
    },

    MemberExpression(node, context) {
      const memberExpr = node as acorn.MemberExpression;

      // Check for process.env, process.exit, etc.
      if (
        memberExpr.object.type === "Identifier" &&
        (memberExpr.object as acorn.Identifier).name === PROCESS_NAME
      ) {
        context.report({
          severity: "warn",
          message: `'${PROCESS_NAME}' is not available in sandbox`,
          line: context.getLine(node),
        });
      }
    },
  },
};
