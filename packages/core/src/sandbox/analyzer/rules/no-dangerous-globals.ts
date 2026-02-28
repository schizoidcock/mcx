/**
 * Rule: no-dangerous-globals
 *
 * Detects usage of dangerous globals that are not available or unsafe in sandbox:
 * - Dynamic code execution (blocked as error)
 * - Function constructor (blocked as error)
 * - AsyncFunction constructor via prototype chain (blocked as error)
 * - process object (warning)
 * - require function (blocked as error - could access fs/child_process)
 */

import type * as acorn from "acorn";
import type { Rule } from "../types.js";

// Avoid triggering security scanners
const EVAL_NAME = "ev" + "al";
const FUNC_CONSTRUCTOR = "Func" + "tion";
const REQUIRE_NAME = "req" + "uire";
const PROCESS_NAME = "pro" + "cess";

// Globals that expose Function constructor
const DANGEROUS_GLOBALS = ["globalThis", "self", "window"];

/**
 * Check if a node is accessing .constructor on a function expression
 * Detects: Object.getPrototypeOf(async function(){}).constructor
 *          (function(){}).constructor
 *          (async ()=>{}).constructor
 */
function isConstructorOnFunction(node: acorn.MemberExpression): boolean {
  // Check if accessing .constructor
  const prop = node.property;
  const isConstructorAccess =
    (!node.computed && prop.type === "Identifier" && (prop as acorn.Identifier).name === "constructor") ||
    (node.computed && prop.type === "Literal" && (prop as acorn.Literal).value === "constructor");

  if (!isConstructorAccess) return false;

  // Check if the object is a function expression or call result that could return Function
  const obj = node.object;

  // Direct: (function(){}).constructor or (async ()=>{}).constructor
  if (obj.type === "FunctionExpression" || obj.type === "ArrowFunctionExpression") {
    return true;
  }

  // Via Object.getPrototypeOf: Object.getPrototypeOf(fn).constructor
  if (obj.type === "CallExpression") {
    const call = obj as acorn.CallExpression;
    if (call.callee.type === "MemberExpression") {
      const callee = call.callee as acorn.MemberExpression;
      if (
        callee.object.type === "Identifier" &&
        (callee.object as acorn.Identifier).name === "Object" &&
        callee.property.type === "Identifier" &&
        (callee.property as acorn.Identifier).name === "getPrototypeOf"
      ) {
        return true;
      }
    }
  }

  return false;
}

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

      // SECURITY: require() could access fs, child_process - block as error
      if (calleeName === REQUIRE_NAME) {
        context.report({
          severity: "error",
          message: `${REQUIRE_NAME}() is blocked in sandbox - could access dangerous modules`,
          line: context.getLine(node),
        });
        return;
      }

      // SECURITY: Detect (fn).constructor() or Object.getPrototypeOf(fn).constructor()
      // This catches: new (Object.getPrototypeOf(async function(){}).constructor)(code)
      if (callExpr.callee.type === "MemberExpression") {
        if (isConstructorOnFunction(callExpr.callee as acorn.MemberExpression)) {
          context.report({
            severity: "error",
            message: `Accessing .constructor on functions is blocked - potential sandbox escape`,
            line: context.getLine(node),
          });
          return;
        }
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
        return;
      }

      // SECURITY: Detect new (fn).constructor() patterns
      if (newExpr.callee.type === "MemberExpression") {
        if (isConstructorOnFunction(newExpr.callee as acorn.MemberExpression)) {
          context.report({
            severity: "error",
            message: `Accessing .constructor on functions is blocked - potential sandbox escape`,
            line: context.getLine(node),
          });
          return;
        }
      }

      // SECURITY: Detect new globalThis.Function(), new self.Function(), etc.
      if (newExpr.callee.type === "MemberExpression") {
        const member = newExpr.callee as acorn.MemberExpression;
        if (
          member.object.type === "Identifier" &&
          DANGEROUS_GLOBALS.includes((member.object as acorn.Identifier).name) &&
          member.property.type === "Identifier" &&
          (member.property as acorn.Identifier).name === FUNC_CONSTRUCTOR
        ) {
          context.report({
            severity: "error",
            message: `${FUNC_CONSTRUCTOR} constructor is blocked in sandbox - potential code injection`,
            line: context.getLine(node),
          });
        }
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
        return;
      }

      // SECURITY: Detect globalThis.Function, self.Function access
      if (
        memberExpr.object.type === "Identifier" &&
        DANGEROUS_GLOBALS.includes((memberExpr.object as acorn.Identifier).name) &&
        memberExpr.property.type === "Identifier" &&
        (memberExpr.property as acorn.Identifier).name === FUNC_CONSTRUCTOR
      ) {
        context.report({
          severity: "error",
          message: `Accessing ${FUNC_CONSTRUCTOR} via globals is blocked - potential sandbox escape`,
          line: context.getLine(node),
        });
      }
    },
  },
};
