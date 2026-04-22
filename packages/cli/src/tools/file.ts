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
import { formatError, indexAndSearch, diffSummary } from "./utils.js";
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
  // NOTE: Stale check moved to handleExistingVar for auto-reload support
  return { ok: true };
}

// ============================================================================
// ============================================================================
// Diff summary helpers (Linus style: small, focused functions)
// ============================================================================

/** Group contiguous numbers into ranges: [1,2,3,7,8] -> "1-3, 7-8" */
const groupRanges = (nums: number[]): string => {
  if (nums.length === 0) return '';
  const ranges: string[] = [];
  let start = nums[0], end = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === end + 1) end = nums[i];
    else {
      ranges.push(start === end ? String(start) : `${start}-${end}`);
      start = end = nums[i];
    }
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.slice(0, 3).join(', ') + (ranges.length > 3 ? '...' : '');
};

/** Find first differing line and all modified line numbers */
const findModifiedLines = (oldLines: string[], newLines: string[]) => {
  let firstDiff = -1;
  const modified: number[] = [];
  const minLen = Math.min(oldLines.length, newLines.length);
  for (let i = 0; i < minLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (firstDiff === -1) firstDiff = i + 1;
      modified.push(i + 1);
    }
  }
  return { firstDiff, modified };
};

/** Build diff description parts: ["+5 at 10-14", "modified 3, 7-8"] */
const buildDiffParts = (delta: number, firstDiff: number, modified: number[]): string[] => {
  const parts: string[] = [];
  const sign = delta >= 0 ? '+' : '';
  if (delta !== 0 && firstDiff > 0) {
    parts.push(`${sign}${delta} at ${firstDiff}-${firstDiff + Math.abs(delta) - 1}`);
  } else if (delta !== 0) {
    parts.push(`${sign}${delta} lines`);
  }
  if (modified.length > 0 && modified.length <= 10) {
    parts.push(`modified ${groupRanges(modified)}`);
  } else if (modified.length > 10) {
    parts.push(`modified ${modified.length} lines`);
  }
  return parts;
};

/** Generate diff summary: "10->15 lines (+5 at 6-10, modified 3)" */
function diffSummary(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const delta = newLines.length - oldLines.length;
  const { firstDiff, modified } = findModifiedLines(oldLines, newLines);
  const parts = buildDiffParts(delta, firstDiff, modified);
  const changes = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${oldLines.length}->${newLines.length} lines${changes}`;
}

// Handle existing variable (no path provided)
// ============================================================================

async function handleExistingVar(ctx: ToolContext, params: FileParams): Promise<McpResult> {
  const { storeAs, code, write } = params;
  const existing = getVariable(storeAs);
  const path = getPathByFileVar(storeAs);

  if (!existing?.value) return formatError(`${storeAs} not found\n` + errorTips.loadFirst(storeAs));

  // Auto-reload stale files with diff summary
  let staleNote = '';
  if (path && await isFileStale(path)) {
    const oldContent = existing.value.raw;
    const newContent = await readFile(path, 'utf8');
    staleNote = `Auto-reloaded: ${diffSummary(oldContent, newContent)}\n`;
    storeContent(storeAs, newContent, path);
  }

  return dispatchCode(ctx, code, write, storeAs, path!, `${staleNote}✓ ${storeAs} ready`, staleNote);
}

// ============================================================================
// Handle large file indexing (Linus-style: small focused helpers)
// ============================================================================

function buildNoIntentResult(ctx: ToolContext, content: string, label: string, stored: string): string {
  ctx.contentStore.index(content, label, { contentType: "code" });
  return stored + '\n' + eventTips.autoIndex(label, content.length);
}

function buildIntentResult(ctx: ToolContext, content: string, label: string, intent: string, stored: string): string {
  const { results, terms } = indexAndSearch(content, label, intent, "code");
  if (results.length === 0) {
    const hint = terms.length > 0 ? `\nSearchable: ${terms.join(', ')}` : '';
    return stored + `\nIndexed: ${label}\nNo matches.${hint}\n-> mcx_search() to explore`;
  }
  return stored + '\n' + formatSearchSnippets(results, intent);
}

function handleLargeFile(
  ctx: ToolContext, storeAs: string, path: string, parsed: FileContent, content: string, intent?: string
): McpResult {
  const label = `file:${path}`;
  const stored = formatStored(storeAs, { lines: parsed.lines.length });
  
  return intent
    ? buildIntentResult(ctx, content, label, intent, stored)
    : buildNoIntentResult(ctx, content, label, stored);
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
  
  // If user requested different name with code, reject and guide
  if (storeAs !== existingVar && code) {
    const corrected = code.replaceAll('$' + storeAs, '$' + existingVar);
    return formatError(errorTips.alreadyLoaded(existingVar, corrected));
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

// Normalize JSON double-escapes: \\n → \n (Linus: single purpose helper)
const normalizeEscapes = (s: string): string =>
  s.replace(/\\\\n/g, '\\n').replace(/\\\\t/g, '\\t').replace(/\\\\r/g, '\\r');

async function runCode(
  ctx: ToolContext,
  code: string
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const variables = getAllPrefixed();
  const normalizedCode = normalizeEscapes(code);
  const fullCode = FILE_HELPERS_CODE + "\nreturn (" + normalizedCode + ")";

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
  readyMsg: McpResult,
  prefix: string = ''
): Promise<McpResult> | McpResult {
  if (!code) return readyMsg;
  if (write) return executeAndWrite(ctx, code, varName, filePath, prefix);
  return executeCode(ctx, code, varName, prefix);
}


async function executeCode(
  ctx: ToolContext,
  code: string,
  varName: string,
  prefix: string = ''
): Promise<McpResult> {
  const result = await runCode(ctx, code);
  if (!result.ok) return formatError(`Error on ${varName}: ${result.error}`);

  const output = formatFileResult(result.value, code, prefix);
  if (typeof output === 'string' && output.length > 5000 && code.trim().match(/^\$\w+$/)) {
    return formatError('Returning full file fills context. Use grep/lines instead.');
  }
  return output;
}



// ============================================================================
// Validate write content
// ============================================================================

// ============================================================================
// Duplicate detection helpers
// ============================================================================

const SAFE_PATTERNS: Record<string, (s: string) => boolean> = {
  braces: s => /^[{}\[\]};,]+$/.test(s),
  comments: s => s.startsWith('//') || s.startsWith('/*') || s.startsWith('*'),
  chaining: s => s.startsWith('.') && s.length < 30,
  controlFlow: s => ['break;', 'continue;', 'return;', 'throw;'].includes(s),
  jsx: s => s.startsWith('<') || s === '/>' || s.startsWith('</'),
  modules: s => s.startsWith('import ') || s.startsWith('export '),
  caseBlocks: s => s.startsWith('case ') || s === 'default:',
  tryCatch: s => s.startsWith('try') || s.startsWith('catch') || s.startsWith('finally'),
  arrayPush: s => /^\w+\.push\(/.test(s),
  shortProps: s => /^\w+:\s*[\w"'`\d]+,?$/.test(s),  // Only simple object props
  veryShort: s => s.length < 15,
};

function isSafeToRepeat(trimmed: string): boolean {
  return Object.values(SAFE_PATTERNS).some(check => check(trimmed));
}

/** Get 3-line block starting at index */
const getBlock = (lines: string[], i: number) => 
  [lines[i], lines[i+1], lines[i+2]].map(l => l.trim()).join('\n');

/** Format duplicate preview */
const formatDuplicate = (line: string) => 
  (line.length > 40 ? line.slice(0, 37) + '...' : line) + ' (3-line block repeated)';

function findDuplicatesInContent(content: string): string[] {
  const lines = content.split('\n');
  const duplicates: string[] = [];
  for (let i = 0; i < lines.length - 5; i++) {
    const line1 = lines[i].trim();
    if (!line1 || line1.length < 10 || isSafeToRepeat(line1)) continue;
    const block1 = getBlock(lines, i), block2 = getBlock(lines, i + 3);
    if (block1 === block2 && block1.length > 30) {
      duplicates.push(formatDuplicate(line1));
      i += 5;
    }
  }
  return duplicates;
}

export function validateWriteContent(
  value: unknown, varName: string
): { ok: true; content: string } | { ok: false; error: McpResult } {
  if (typeof value !== 'string') {
    return { ok: false, error: formatError(`${varName}: write requires code to return string\n💡 write requires JS expression returning string, e.g.: $var.raw.replace('old', 'new')`) };
  }
  
  const content = value.replace(/\r\n/g, '\n');
  const braceCheck = checkBraceBalance(content);
  
  if (braceCheck.balance !== 0) {
    const count = Math.abs(braceCheck.balance);
    const type = braceCheck.balance > 0 ? 'unclosed' : 'unmatched';
    const lines = braceCheck.balance > 0 ? braceCheck.unclosedLines : braceCheck.unmatchedLines;
    return { ok: false, error: formatError(`unbalanced braces - ${count} ${type} brace(s) at line(s): ${lines.join(', ')}`) };
  }

  const duplicates = findDuplicatesInContent(content);
  if (duplicates.length > 0) {
    return { ok: false, error: formatError(`Suspicious duplicates:\n${duplicates.join('\n')}`) };
  }
  
  return { ok: true, content };
}


async function executeAndWrite(
  ctx: ToolContext, code: string, varName: string, filePath: string
): Promise<McpResult> {
  // Get old content for diff
  const oldVar = getVariable(varName);
  const oldContent = oldVar?.value?.raw || '';

  const result = await runCode(ctx, code);
  if (!result.ok) return formatError(result.error);

  const validated = validateWriteContent(result.value, varName);
  if (!validated.ok) return validated.error;

  // Detect failed replaces (content unchanged)
  if (validated.content === oldContent) {
    return formatError(`${varName}: content unchanged - replace pattern may not have matched`);
  }

  await writeFile(filePath, validated.content);
  recordEdit(filePath);
  // NOTE: No recordStore here - allows stale detection for subsequent reads
  trackToolUsage("mcx_file", filePath);

  // Generate diff summary
  const diff = oldContent ? diffSummary(oldContent, validated.content) : '';
  const diffNote = diff ? ` ${diff}` : '';

  return `✓ Wrote ${validated.content.length} chars to ${filePath}${diffNote}`;
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
      storeAs: { type: "string", description: "Variable name (e.g., 'x' -> $x)" },
      code: { type: "string", description: "JS code with helpers (grep, lines, etc.)" },
      clear: { type: "boolean", description: "Clear all file variables" },
      intent: { type: "string", description: "Auto-search after indexing large files" },
      write: { type: "boolean", description: "Write code result back to file (code must return string)" },
    },
  },
  handler: handleFile,
};// test comment 1776847574
