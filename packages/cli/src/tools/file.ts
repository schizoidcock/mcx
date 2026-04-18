/**
 * mcx_file Tool
 *
 * Read file into variable OR use existing variable. Process with JS helpers.
 * This is the ONLY tool for file operations. Shell/Python file ops redirect here.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, basename, resolve } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { normalizePath } from "../utils/paths.js";
import { formatError, indexAndSearch } from "./utils.js";
import { FILE_HELPERS_CODE } from "../context/create.js";
import { formatFileResult, formatStored } from "../utils/truncate.js";
import { updateProximityContext, trackFsBytes, trackToolUsage, suggestNextTool } from "../context/tracking.js";
import { errorTips, eventTips } from "../context/tips.js";
import { getVariable, setFileVariable, getAllPrefixed, getFileVarByPath, getPathByFileVar, clearFileVariables } from "../context/variables.js";
import { getStoredAt, getEditedAt, recordStore, recordEdit } from "../context/files.js";
import { FILE_INDEX_THRESHOLD } from "./constants.js";
import { formatSearchSnippets } from "../search/snippets.js";
import { checkBraceBalance } from "../utils/syntax.js";

// ============================================================================

// Types
// ============================================================================

export interface FileParams {
  path?: string;     // Optional if variable already exists
  storeAs?: string;  // Required unless clear: true
  code?: string;     // Optional JS code with helpers
  clear?: boolean;   // Clear all file variables
  intent?: string;   // Auto-search after indexing large files
  write?: boolean;   // Write code result back to file
}

interface FileContent {
  raw: string;       // Content without line numbers (for write)
  text: string;
  lines: string[];
  path: string;
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Check if file needs reload (stale detection).
 * Checks both MCX internal edits and external filesystem changes.
 */

async function isFileStale(path: string): Promise<boolean> {
  const storeTime = getStoredAt(path);
  if (!storeTime) return false;

  // Check MCX internal edits
  const editTime = getEditedAt(path);
  if (editTime && editTime > storeTime) return true;

  // Check external edits via filesystem mtime
  try {
    const fileStat = await stat(path);
    return fileStat.mtimeMs > storeTime;
  } catch {
    return false;
  }
}



// ============================================================================
// Validation
// ============================================================================

function validateParams(params: FileParams): { ok: true } | { ok: false; error: McpResult } {
  const { storeAs, code, write, intent } = params;
  
  if (!storeAs) return { ok: false, error: formatError("Missing storeAs parameter") };
  if (write && !code) return { ok: false, error: formatError("write: true requires code parameter") };
  if (intent && code) return { ok: false, error: formatError("Cannot use intent and code together") };
  
  if (write) {
    const existingPath = getPathByFileVar(storeAs);
    if (existingPath && getEditedAt(existingPath) > (getStoredAt(existingPath) || 0)) {
      return { ok: false, error: formatError(`${storeAs} is stale - reload before write\n` + errorTips.reload(existingPath, storeAs)) };
    }
  }
  
  return { ok: true };
}

// ============================================================================
// Handle existing variable (no path provided)
// ============================================================================

async function handleExistingVar(ctx: ToolContext, params: FileParams): Promise<McpResult> {
  const { storeAs, code, write } = params;
  const existing = getVariable(storeAs);
  const path = getPathByFileVar(storeAs);
  
  if (!existing?.value) return formatError(`$${storeAs} not found\n` + errorTips.loadFirst(storeAs));
  
  if (path && await isFileStale(path)) {
    return formatError(`$${storeAs} is stale (file was edited)\n` + errorTips.reload(path, storeAs));
  }
  
  return dispatchCode(ctx, code, write, storeAs, path!, `✓ ${storeAs} ready`);
}

// ============================================================================
// Handle large file indexing
// ============================================================================

function handleLargeFile(
  ctx: ToolContext, storeAs: string, path: string, parsed: FileContent, content: string, intent?: string
): McpResult {
  const label = `file:${path}`;
  
  if (!intent) {
    ctx.contentStore.index(content, label, { contentType: "code" });
    const msg = formatStored(storeAs, { lines: parsed.lines.length }) + '\n' + eventTips.autoIndex(label, content.length);
    return msg;
  }
  
  const { results, terms } = indexAndSearch(content, label, intent, "code");
  if (results.length === 0) {
    const hint = terms.length > 0 ? `\nSearchable: ${terms.join(', ')}` : '';
    return formatStored(storeAs, { lines: parsed.lines.length }) + `\nIndexed: ${label}\nNo matches.${hint}\n→ mcx_search() to explore`;
  }
  return formatStored(storeAs, { lines: parsed.lines.length }) + '\n' + formatSearchSnippets(results, intent);
}

// ============================================================================
// Load file from disk
// ============================================================================

// Check if file is cached and valid
async function checkCached(
  ctx: ToolContext, params: FileParams, resolvedPath: string
): Promise<McpResult | null> {
  const { storeAs, code, write } = params;
  const existing = getVariable(storeAs);
  const existingPath = getPathByFileVar(storeAs);
  
  if (!existing?.value || existingPath !== resolvedPath) return null;
  if (await isFileStale(resolvedPath)) return null;
  
  return dispatchCode(ctx, code, write, storeAs, resolvedPath, `✓ ${storeAs} ready (cached)`);
}

// Check if file already stored under different variable name
async function checkDuplicateVar(
  ctx: ToolContext, params: FileParams, resolvedPath: string
): Promise<McpResult | null> {
  const { storeAs, code, write } = params;
  const existingVar = getFileVarByPath(resolvedPath);
  
  if (!existingVar || existingVar === storeAs) return null;
  if (await isFileStale(resolvedPath)) {
    return formatError(`${existingVar} is stale\n` + errorTips.reload(resolvedPath, existingVar));
  }
  
  return dispatchCode(ctx, code, write, existingVar, resolvedPath, `✓ Already stored as ${existingVar}`);
}

// Store file content and track access
function storeContent(storeAs: string, content: string, resolvedPath: string): FileContent {
  updateProximityContext([resolvedPath], []);
  trackFsBytes(content.length);
  const parsed = parseFileContent(content, resolvedPath);
  setFileVariable(storeAs, parsed, resolvedPath);
  recordStore(resolvedPath);
  return parsed;
}

// Load file from disk - orchestrator
async function loadFile(ctx: ToolContext, params: FileParams): Promise<McpResult> {
  const { storeAs, code, write, intent } = params;
  const path = normalizePath(params.path!);
  
  if (!isAbsolute(path)) return formatError(`Absolute path required. Got: "${params.path}"`);
  const resolvedPath = normalizePath(resolve(path));
  
  // Check cache
  const cached = await checkCached(ctx, params, resolvedPath);
  if (cached) return cached;
  
  // Check duplicate
  const duplicate = await checkDuplicateVar(ctx, params, resolvedPath);
  if (duplicate) return duplicate;
  
  // Read file
  let content: string;
  try { content = await readFile(resolvedPath, "utf-8"); }
  catch { return formatError(`File not found: ${resolvedPath}`); }
  
  // Store and dispatch
  const parsed = storeContent(storeAs, content, resolvedPath);
  if (content.length > FILE_INDEX_THRESHOLD) {
    return handleLargeFile(ctx, storeAs, resolvedPath, parsed, content, intent);
  }
  return dispatchCode(ctx, code, write, storeAs, resolvedPath, formatStored(storeAs, { lines: parsed.lines.length }));
}

// ============================================================================
// Main handler - orchestrator
// ============================================================================

async function handleFile(ctx: ToolContext, params: FileParams): Promise<McpResult> {
  // Clear variables
  if (params.clear) {
    const cleared = clearFileVariables();
    return `✓ Cleared ${cleared} file variable${cleared !== 1 ? 's' : ''}`;
  }
  
  // Normalize path
  if (params.path) params.path = normalizePath(params.path);
  
  // Validate
  const validated = validateParams(params);
  if (!validated.ok) return validated.error;
  
  // Route
  if (!params.path) return handleExistingVar(ctx, params);
  return loadFile(ctx, params);
}

function parseFileContent(content: string, path: string): FileContent {
  const lines = content.split("\n").map((l, i) => `${i + 1}: ${l}`);
  return { raw: content, text: lines.join("\n"), lines, path };
}

/**
 * Execute code in sandbox - ONE source of truth for code execution.
 */

async function runCode(
  ctx: ToolContext,
  code: string
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const variables = getAllPrefixed();
  const fullCode = FILE_HELPERS_CODE + "\
return (" + code + ")";

  try {
    const result = await ctx.sandbox.execute(fullCode, {
      adapters: ctx.adapterContext,
      variables,
      env: {},
    });
    if (!result.success) return { ok: false, error: (result.error?.message || "Execution failed") + "\n💡 write requires JS expression returning string, e.g.: $var.raw.replace('old', 'new')" };
    return { ok: true, value: result.value };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ONE source of truth: dispatch code/write/execute

function dispatchCode(
  ctx: ToolContext,
  code: string | undefined,
  write: boolean | undefined,
  varName: string,
  filePath: string,
  readyMsg: McpResult
): Promise<McpResult> | McpResult {
  if (!code) return readyMsg;
  if (write) return executeAndWrite(ctx, code, varName, filePath);
  return executeCode(ctx, code, varName);
}


async function executeCode(
  ctx: ToolContext,
  code: string,
  varName: string
): Promise<McpResult> {
  const result = await runCode(ctx, code);
  if (!result.ok) return formatError(`Error on ${varName}: ${result.error}`);

  const output = formatFileResult(result.value, code);
  if (typeof output === 'string' && output.length > 5000 && code.trim().match(/^\$\w+$/)) {
    return formatError('Returning full file fills context. Use grep/lines instead.');
  }
  return output;
}



// ============================================================================
// Validate write content
// ============================================================================

function validateWriteContent(
  value: unknown, varName: string
): { ok: true; content: string } | { ok: false; error: McpResult } {
  if (typeof value !== 'string') {
    return { ok: false, error: formatError(`${varName}: write requires code to return string\n💡 write requires JS expression returning string, e.g.: $var.raw.replace('old', 'new')`) };
  }
  
  const content = value.replace(/\r\n/g, '\n');
  const braceCheck = checkBraceBalance(content);
  
  if (braceCheck.balance !== 0) {
    const info = braceCheck.balance > 0
      ? `Unclosed { at lines: ${braceCheck.unclosedLines.join(', ')}`
      : `Unmatched } at lines: ${braceCheck.unmatchedLines.join(', ')}`;
    return { ok: false, error: formatError(`Unbalanced braces (${Math.abs(braceCheck.balance)})\n${info}`) };
  }
  
  return { ok: true, content };
}


async function executeAndWrite(
  ctx: ToolContext, code: string, varName: string, filePath: string
): Promise<McpResult> {
  const result = await runCode(ctx, code);
  if (!result.ok) return formatError(`Error on ${varName}: ${result.error}`);
  
  const validated = validateWriteContent(result.value, varName);
  if (!validated.ok) return validated.error;
  
  await writeFile(filePath, validated.content);
  recordEdit(filePath);
  recordStore(filePath);  // Update store time so file is not considered stale
  trackToolUsage("mcx_file", filePath);
  
  return `✓ Wrote ${validated.content.length} chars to ${filePath}`;
}

export const mcxFile: ToolDefinition<FileParams> = {
  name: "mcx_file",
  description: `Read file into variable OR query existing variable with helpers.

**Load file:**
mcx_file({ path: "/abs/path/file.ts", storeAs: "x" })

**Use existing variable:**
mcx_file({ storeAs: "x", code: "grep($x, 'TODO')" })

**Edit and write back:**
mcx_file({ storeAs: "x", code: "$x.raw.replace(/old/g, 'new')", write: true })

**Helpers:**
- grep($var, 'pattern') - search content
- lines($var, start, end) - get line range
- around($var, lineNum, ctx) - context around line
- block($var, lineNum) - get code block
- outline($var) - structure overview
- $var.raw - content without line numbers (for write)

**Stale detection:** If file was edited since loading, you'll be prompted to reload.

Note: Shell/Python file operations in mcx_execute redirect here.`,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path (required for new files, optional if variable exists)" },
      storeAs: { type: "string", description: "Variable name (e.g., 'x' → $x)" },
      code: { type: "string", description: "JS code with helpers (grep, lines, etc.)" },
      clear: { type: "boolean", description: "Clear all file variables" },
      intent: { type: "string", description: "Auto-search after indexing large files" },
      write: { type: "boolean", description: "Write code result back to file (code must return string)" },
    },
  },
  handler: handleFile,
};