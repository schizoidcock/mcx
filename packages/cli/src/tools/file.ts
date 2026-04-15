/**
 * mcx_file Tool
 *
 * Read file into variable OR use existing variable. Process with JS helpers.
 * This is the ONLY tool for file operations. Shell/Python file ops redirect here.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, basename, resolve } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { normalizePath } from "../utils/paths.js";
import { formatError } from "./utils.js";
import { FILE_HELPERS_CODE } from "../context/create.js";
import { formatFileResult, formatStored } from "../utils/truncate.js";
import { updateProximityContext, trackFsBytes } from "../context/tracking.js";
import { errorTips, eventTips } from "../context/tips.js";
import { getSandboxState } from "../sandbox/index.js";
import { getEditTime } from "./edit.js";
import { FILE_INDEX_THRESHOLD } from "./constants.js";

// ============================================================================
// Types
// ============================================================================

export interface FileParams {
  path?: string;     // Optional if variable already exists
  storeAs: string;   // Required - variable name
  code?: string;     // Optional JS code with helpers
}

// ============================================================================
// Main Handler
// ============================================================================

async function handleFile(
  ctx: ToolContext,
  params: FileParams
): Promise<McpResult> {
  const { path: pathInput, storeAs, code } = params;
  
  // Normalize path: backslash → forward slash (Windows compatibility)
  const path = pathInput ? normalizePath(pathInput) : undefined;

  if (!storeAs) return formatError("Missing storeAs parameter");
  
  // Prohibit path + code together - must be separate calls
  if (pathInput && code) {
    return formatError(
      "Cannot use path and code together",
      "First load: mcx_file({ path: \"...\", storeAs: \"x\" })\nThen query: mcx_file({ storeAs: \"x\", code: \"...\" })"
    );
  }

  const state = getSandboxState();
  const existingValue = state.get(storeAs);
  const existingPath = state.getPathForVar(storeAs);
  
  // Check if variable exists and if it's stale
  let needsReload = false;
  if (existingPath) {
    const storeTime = state.getFileStoreTime(existingPath);
    const editTime = getEditTime(existingPath);
    needsReload = !!(storeTime && editTime && editTime > storeTime);
  }

  // Mode 1: Use existing variable (no path, not stale)
  if (!pathInput && existingValue && !needsReload) {
    if (!code) {
      return `✓ ${storeAs} ready`;
    }
    return executeCode(ctx, code, storeAs);
  }

  // Mode 2: Variable is stale, needs reload
  if (!pathInput && needsReload) {
    return formatError(
      `$${storeAs} is stale (file was edited)\n` +
      errorTips.reload(existingPath!, storeAs)
    );
  }

  // Mode 3: Variable doesn't exist, need path
  if (!pathInput && !existingValue) {
    return formatError(
      `$${storeAs} not found\n` +
      errorTips.loadFirst(storeAs)
    );
  }

  // Mode 4: Load file (path provided)
  if (!isAbsolute(path!)) {
    return formatError(`Absolute path required. Got: "${pathInput}"`);
  }
  
  const resolvedPath = normalizePath(resolve(path!));

  // Mode 4.1: Already stored and not stale - use cached
  if (existingValue && existingPath === resolvedPath && !needsReload) {
    if (!code) {
      return `✓ ${storeAs} ready (cached)`;
    }
    return executeCode(ctx, code, storeAs);
  }

  let content: string;
  try {
    content = await readFile(resolvedPath, "utf-8");
  } catch {
    return formatError(`File not found: ${resolvedPath}`);
  }

  // Check if same file already stored under different name
  const existingVarForPath = state.getFileVar(resolvedPath);
  if (existingVarForPath && existingVarForPath !== storeAs) {
    return formatError(
      `File already stored as $${existingVarForPath}\n` +
      errorTips.useExisting(existingVarForPath)
    );
  }

  // Track file access and bytes read
  updateProximityContext([resolvedPath], []);
  trackFsBytes(content.length);
  const parsed = parseFileContent(content, resolvedPath);
  state.set(storeAs, parsed);
  state.setFileVar(resolvedPath, storeAs);

  // Auto-index large files (label uses path for useful search filtering)
  let indexMsg = '';
  if (content.length > FILE_INDEX_THRESHOLD) {
    const label = `file:${resolvedPath}`;
    ctx.contentStore.index(content, label, { contentType: "code" });
    indexMsg = '\n' + eventTips.autoIndex(label, content.length);
  }

  // Return result
  if (!code) {
    return formatStored(storeAs, { lines: parsed.lines.length }) + indexMsg;
  }

  return executeCode(ctx, code, storeAs);
}

// ============================================================================
// Helpers
// ============================================================================

interface FileContent {
  text: string;
  lines: string[];
  path: string;
}

function parseFileContent(content: string, path: string): FileContent {
  const lines = content.split("\n").map((l, i) => `${i + 1}: ${l}`);
  return { text: lines.join("\n"), lines, path };
}


async function executeCode(
  ctx: ToolContext,
  code: string,
  varName: string
): Promise<McpResult> {
  const variables = getSandboxState().getAllPrefixed();
  
  // Helpers are available directly (grep, lines, around, block, outline)
  const fullCode = FILE_HELPERS_CODE + "\nreturn (" + code + ")";
  
  try {
    const result = await ctx.sandbox.execute(fullCode, {
      adapters: ctx.adapterContext || {},
      variables,
      env: {},
    });

    if (!result.success) {
      return formatError(result.error?.message || "Execution failed");
    }

    const output = formatFileResult(result.value, code);
    if (typeof output === 'string' && output.length > 5000 && code.trim().match(/^\$\w+$/)) {
      return formatError('Returning full file fills context. Use grep/lines instead.');
    }
    return output;
  } catch (err) {
    return formatError(`Execution failed: ${String(err)}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxFile: ToolDefinition<FileParams> = {
  name: "mcx_file",
  description: `Read file into variable OR query existing variable with helpers.

**Load file:**
mcx_file({ path: "/abs/path/file.ts", storeAs: "x" })
mcx_file({ path: "/abs/path/file.ts", storeAs: "x", code: "grep($x, 'TODO')" })

**Use existing variable:**
mcx_file({ storeAs: "x", code: "lines($x, 100, 200)" })

**Helpers:**
- grep($var, 'pattern') - search content
- lines($var, start, end) - get line range
- around($var, lineNum, ctx) - context around line
- block($var, lineNum) - get code block
- outline($var) - structure overview

**Stale detection:** If file was edited since loading, you'll be prompted to reload.

Note: Shell/Python file operations in mcx_execute redirect here.`,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path (required for new files, optional if variable exists)" },
      storeAs: { type: "string", description: "Variable name (e.g., 'x' → $x)" },
      code: { type: "string", description: "JS code with helpers (grep, lines, etc.)" },
    },
    required: ["storeAs"],
  },
  handler: handleFile,
};
