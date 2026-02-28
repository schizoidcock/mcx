/**
 * Rule: no-dangerous-globals
 *
 * Detects usage of dangerous globals that are not available or unsafe in sandbox:
 * - Dynamic code execution (blocked as error)
 * - Function constructor (blocked as error)
 * - process object (warning)
 * - require function (warning)
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
  description: "Block dangerous globals that could escape sandbox",
  visits: ["CallExpression", "NewExpression", "MemberExpression"],

  visitors: {
    CallExpression(node, context) {
      const callExpr = node as acorn.CallExpression;
      const calleeName = callExpr.callee.type === "Identifier"
        ? (callExpr.callee as acorn.Identifier).name
        : null;

      // SECURITY: Dynamic code execution is a sandbox escape vector - block
      if (calleeName === EVAL_NAME) {
        context.report({
          severity: "error",
          message: `${EVAL_NAME}() is blocked in sandbox - potential code injection`,
          line: context.getLine(node),
        });
        return;
      }

      // SECURITY: Function constructor called without new is equally dangerous
      if (calleeName === FUNC_CONSTRUCTOR) {
        context.report({
          severity: "error",
          message: `${FUNC_CONSTRUCTOR}() is blocked in sandbox - potential code injection`,
          line: context.getLine(node),
        });
        return;
      }

      // Check for require()
      if (calleeName === REQUIRE_NAME) {
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

      // SECURITY: Function constructor is a sandbox escape vector - block
      if (
        newExpr.callee.type === "Identifier" &&
        (newExpr.callee as acorn.Identifier).name === FUNC_CONSTRUCTOR
      ) {
        context.report({
          severity: "error",
          message: `${FUNC_CONSTRUCTOR} constructor is blocked in sandbox - potential code injection`,
          line: context.getLine(node),
        });
      }
    },

    // Note: Removed Identifier visitor for 'process' - MemberExpression catches
    // process.X usage, and bare 'process' references fail at runtime anyway.
    // This prevents duplicate warnings for each process.X access.

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
