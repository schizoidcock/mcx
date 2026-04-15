/**
 * Tool Context Management
 * 
 * Creates and manages the shared context for all MCP tools.
 * Centralizes state that was previously scattered in serve.ts closures.
 */

export { createToolContext, type ToolContextConfig } from "./create.js";
export { getContentStore, clearContentStore } from "./store.js";
export { 
  getVariable, 
  setVariable, 
  clearVariables,
  getLastResult,
  setLastResult,
} from "./variables.js";
export {
  trackToolUsage,
  suggestNextTool,
  updateProximityContext,
  getProximityScore,
} from "./tracking.js";
export {
  updateFile,
  recordStore,
  recordEdit,
  recordAccess,
  isStale,
  getStoredAt,
  getEditedAt,
  getAccessCount,
  hasStored,
} from "./files.js";
export { getTips, getFirstTip, type TipContext } from "./tips.js";
