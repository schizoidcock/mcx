/**
 * Rule exports for the Pre-execution Analyzer
 */

export { rule as noInfiniteLoop } from "./no-infinite-loop.js";
export { rule as noNestedLoops } from "./no-nested-loops.js";
export { rule as noAdapterInLoop } from "./no-adapter-in-loop.js";
export { rule as noUnhandledAsync } from "./no-unhandled-async.js";
export { rule as noDangerousGlobals } from "./no-dangerous-globals.js";

import { rule as noInfiniteLoop } from "./no-infinite-loop.js";
import { rule as noNestedLoops } from "./no-nested-loops.js";
import { rule as noAdapterInLoop } from "./no-adapter-in-loop.js";
import { rule as noUnhandledAsync } from "./no-unhandled-async.js";
import { rule as noDangerousGlobals } from "./no-dangerous-globals.js";
import type { Rule } from "../types.js";

/**
 * All built-in rules
 */
export const allRules: Rule[] = [
  noInfiniteLoop,
  noNestedLoops,
  noAdapterInLoop,
  noUnhandledAsync,
  noDangerousGlobals,
];
