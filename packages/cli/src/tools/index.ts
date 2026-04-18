/**
 * MCP Tools
 * 
 * Modular tool definitions extracted from serve.ts.
 * Each tool is a separate module with its own handler.
 */

// Types
export type {
  ToolContext,
  ToolHandler,
  ToolDefinition,
  McpResult,
  SessionVariables,
  SessionWorkflow,
  StoredVariable,
  AdapterContext,
  BackgroundTask,
  SkillDef,
  FileResult,
  SearchResult,
  GrepResult,
} from "./types.js";

export { createEmptyContext } from "./types.js";

// Utilities
export { formatToolResult, formatError } from "./utils.js";

// Tools (extracted from serve.ts)
export { mcxWrite } from "./write.js";
export { mcxDoctor } from "./doctor.js";
export { mcxUpgrade } from "./upgrade.js";
export { mcxWatch } from "./watch.js";
export { mcxGrep } from "./grep.js";
export { mcxFind } from "./find.js";
export { mcxFetch } from "./fetch.js";
export { mcxStats } from "./stats.js";
export { mcxTasks } from "./tasks.js";
export { createAdapterTool } from "./adapter.js";
export { mcxFile } from "./file.js";
export { mcxSearch } from "./search.js";
export { createExecuteTool } from "./execute.js";
export { registerExtractedTools } from "./register.js";

// Formatting utilities
export { formatGrepMCX, formatFindResults } from "./format-grep.js";
