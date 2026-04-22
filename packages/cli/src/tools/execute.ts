/**
 * mcx_execute Tool
 *
 * Execute JavaScript/TypeScript code OR shell commands.
 */

import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import type { ResolvedSpec } from "../spec/types.js";
import { formatError, indexAndSearch } from "./utils.js";
import { truncateLogs, filterHelperLogs, formatStored } from "../utils/truncate.js";
import { extractImages } from "../utils/images.js";
import { applyHybridFilter } from "../filters/index.js";
import { detectAndFormatGrepOutput } from "./format-grep.js";
import { getAllPrefixed, setVariable, deleteVariable, clearVariables, setLastResult } from "../context/variables.js";
import { AUTO_INDEX_THRESHOLD, INTENT_THRESHOLD } from "./constants.js";
import { formatSearchSnippets } from "../search/snippets.js";
import { classifyExit } from "../utils/exit.js";


import { DANGEROUS_ENV_KEYS, detectShellEscape, enforceRedirects } from "../utils/security.js";
// Guards and tracking
import { getCodeSignature, checkRetryLoop, recordFailure, clearFailure, checkLinesHunting } from "../context/guards.js";
import { trackMethodUsage, trackSandboxIO } from "../context/tracking.js";
import { eventTips } from "../context/tips.js";
import { analyzeExecuteParams, formatTraitWarnings } from "../utils/traits.js";
import { safeShell, safePython } from "../utils/process.js";
import { DEFAULT_TIMEOUT } from "./constants.js";

// ============================================================================
// Safe Environment
// ============================================================================

let cachedSafeEnv: Record<string, string> | null = null;

function getSafeEnv(): Record<string, string> {
  if (cachedSafeEnv) return cachedSafeEnv;
  
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (DANGEROUS_ENV_KEYS.has(key)) continue;
    if (key.includes('SECRET') || key.includes('PASSWORD')) continue;
    if (key.includes('TOKEN') || key.includes('CREDENTIAL')) continue;
    safeEnv[key] = value;
  }
  
  cachedSafeEnv = safeEnv;
  return safeEnv;
}
// ============================================================================
// Types
// ============================================================================

export interface ExecuteParams {
  code?: string;
  shell?: string;
  python?: string;
  storeAs?: string;
  intent?: string;
  clear?: boolean;
  delete?: string;
  timeout?: number;
}


interface ExecOptions {
  storeAs?: string;
  timeout?: number;
}

/** Result from shell/python execution (data, not formatted) */
interface ShellResult {
  output: string;
  lines: number;
  exitCode: number;
  varName: string;
  truncated: boolean;
  errorMsg?: string;  // Filtered error message if exitCode !== 0
}

// ============================================================================
// Code Execution (Mode 1)
// ============================================================================

/** Extract and format logs (Linus: eliminate duplication) */
function extractLogs(result: { logs?: string[] }): string[] {
  return result.logs?.length ? truncateLogs(filterHelperLogs(result.logs)) : [];
}

async function executeCode(
  ctx: ToolContext,
  code: string,
  storeAs?: string
): Promise<McpResult> {
  // Enforce redirects to MCX tools
  const blocked = enforceRedirects(code, 'javascript');
  if (blocked) return blocked;

  // Build variables from session state
  let variables: Record<string, unknown> = {};
  try {
    variables = { ...getAllPrefixed() };
  } catch {
    // Ignore errors getting variables
  }

  // Add last result as $result
  if (ctx.variables.lastResult !== undefined) {
    variables.$result = ctx.variables.lastResult;
  }

  try {
    // Include helpers for data processing (pick, keys, values, paths, tree)
    // File-specific helpers (grep, lines, around, block, outline) also available
    // but require variables with .lines property (from mcx_file storeAs)
    const helpers = ctx.fileHelpersCode || '';
    const fullCode = helpers + code;
    
    // Sandbox expects { adapters, variables, env } structure
    const result = await ctx.sandbox.execute(fullCode, {
      adapters: ctx.adapterContext,
      variables,
      env: {},
    });

    // Check for sandbox errors
    if (!result.success) {
      const err = result.error;
      const logs = extractLogs(result);
      const logsSection = logs.length ? `\n\n[Logs]\n${logs.join('\n')}` : '';
      return formatError(`${err?.name || 'Error'}: ${err?.message || 'Unknown error'}${logsSection}`);
    }

    // Extract images from result
    const { value, images } = extractImages(result.value);

    // Track I/O from sandbox execution
    trackSandboxIO(result.tracking);

    // Store result in session variables (without images - they're extracted)
    setLastResult(value);
    if (storeAs) {
      setVariable(storeAs, value);
    }

    // Format confirmation (value stays in $result, not in context)
    const varName = storeAs || 'result';
    const logs = extractLogs(result);
    const valueStr = formatValue(value);
    const lines = valueStr.split('\n').length;
    
    // Include logs for debugging, but not the full value
    const logsSection = logs.length ? `\n[Logs]\n${logs.join('\n')}` : '';
    const text = formatStored(varName, { lines }) + logsSection;
    
    // Return with images if present
    if (images.length > 0) {
      return {
        content: [
          { type: "text" as const, text },
          ...images.map(img => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }))
        ]
      };
    }
    return text;
  } catch (err) {
    return formatError(`Execution failed: ${String(err)}`);
  }
}

// NO truncation here - wrapper handles it centrally
function formatValue(value: unknown): string {
  if (value === undefined) return "(undefined)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ============================================================================
// Shell Execution (Mode 2)
// ============================================================================

async function executeShell(
  ctx: ToolContext,
  command: string,
  opts: ExecOptions = {}
): Promise<ShellResult | McpResult> {
  const { storeAs, timeout = DEFAULT_TIMEOUT } = opts;
  const cmd = command.trim();
  if (!cmd) return formatError("Empty command");

  const blocked = enforceRedirects(cmd, 'shell');
  if (blocked) return blocked;

  const spawnResult = await safeShell(cmd, {
    cwd: process.cwd(),
    env: getSafeEnv(),
    timeout,
  });

  if (spawnResult.timedOut) {
    return formatError(`Command timed out after ${timeout}ms`);
  }

  const result = {
    exitCode: spawnResult.exitCode,
    stdout: spawnResult.stdout.trim(),
    stderr: spawnResult.stderr.trim(),
    command: cmd,
  };

  // Store in session variables
  setLastResult(result);
  if (storeAs) setVariable(storeAs, result);

  const varName = storeAs || 'result';
  const output = result.stdout || result.stderr || '';
  const lines = output.split('\n').filter(Boolean).length;

  // Prepare error message if failed
  let errorMsg: string | undefined;
  if (spawnResult.exitCode !== 0) {
    const rawErr = result.stderr || result.stdout || '(no output)';
    const filtered = applyHybridFilter(cmd, rawErr) ?? rawErr;
    errorMsg = filtered.slice(0, 500);
  }

  return { output, lines, exitCode: spawnResult.exitCode, varName, truncated: spawnResult.truncated, errorMsg };
}

// ============================================================================
// Python Execution (Mode 3)
// ============================================================================

async function executePython(
  ctx: ToolContext,
  code: string,
  opts: ExecOptions = {}
): Promise<ShellResult | McpResult> {
  const { storeAs, timeout = DEFAULT_TIMEOUT } = opts;
  const pythonCode = code.trim();
  if (!pythonCode) return formatError("Empty Python code");

  const escape = detectShellEscape(pythonCode, 'python');
  if (escape.detected) return formatError(escape.suggestion);

  const blocked = enforceRedirects(pythonCode, 'python');
  if (blocked) return blocked;

  const spawnResult = await safePython(pythonCode, {
    cwd: process.cwd(),
    env: getSafeEnv(),
    timeout,
  });

  if (spawnResult.timedOut) {
    return formatError(`Python execution timed out after ${timeout}ms`);
  }

  const result = {
    exitCode: spawnResult.exitCode,
    stdout: spawnResult.stdout.trim(),
    stderr: spawnResult.stderr.trim(),
  };

  // Store in session variables
  setLastResult(result);
  if (storeAs) setVariable(storeAs, result);

  const varName = storeAs || 'result';
  const output = result.stdout || result.stderr || '';
  const lines = output.split('\n').filter(Boolean).length;

  // Prepare error message if failed
  let errorMsg: string | undefined;
  if (spawnResult.exitCode !== 0) {
    const rawErr = result.stderr || result.stdout || '(no output)';
    const filtered = applyHybridFilter('python', rawErr) ?? rawErr;
    errorMsg = filtered.slice(0, 500);
  }

  return { output, lines, exitCode: spawnResult.exitCode, varName, truncated: spawnResult.truncated, errorMsg };
}

// ============================================================================
// Intent-based Indexing
// ============================================================================

function handleLargeOutput(
  ctx: ToolContext,
  output: string,
  intent: string,
  varName: string
): McpResult {
  const { results, terms } = indexAndSearch(output, intent, intent, "plaintext");

  if (results.length === 0) {
    const hint = terms.length > 0 ? `\nSearchable: ${terms.join(', ')}` : '';
    return `✓ Stored ${varName}\nIndexed: ${intent}\nNo matches.${hint}\n-> mcx_search() to explore`;
  }

  return `✓ Stored ${varName}\n` + formatSearchSnippets(results, intent) + `\n-> mcx_search({ queries: ["${intent}"] }) for more`;
}

// ============================================================================
// Main Handler
// ============================================================================

async function handleExecute(
  ctx: ToolContext,
  params: ExecuteParams
): Promise<McpResult> {
  const { code, shell, python, storeAs, intent, clear, delete: deleteVar, timeout } = params;

  // Variable management (no code/shell/python needed)
  if (clear) {
    clearVariables();
    return "✓ All variables cleared";
  }
  if (deleteVar) {
    const deleted = deleteVariable(deleteVar);
    return deleted ? `✓ Deleted ${deleteVar}` : formatError(`Variable ${deleteVar} not found`);
  }

  // Validate: exactly one mode
  const modes = [code, shell, python].filter(Boolean);
  if (modes.length === 0) {
    return formatError(
      "Specify one of: code (JS/TS), shell (command), python (code)\n" +
      "Examples:\n" +
      "- mcx_execute({ code: \"2 + 2\" })\n" +
      "- mcx_execute({ shell: \"git status\" })\n" +
      "- mcx_execute({ python: \"print('hello')\" })"
    );
  }
  if (modes.length > 1) {
    return formatError("Specify only one of: code, shell, or python");
  }

  // Trait analysis - single entry point for all modes
  const traits = analyzeExecuteParams(params);
  const traitWarning = traits ? formatTraitWarnings(traits) : '';


  // Guards: check retry loop and lines hunting (code mode only)
  let retryWarning = "";
  let sig = "";
  if (code) {
    sig = getCodeSignature(code);
    const warning = checkRetryLoop(sig);
    if (warning) retryWarning = warning;

    // Check lines hunting
    const linesMatch = code.match(/lines\(\$(\w+),\s*(\d+),\s*(\d+)\)/);
    if (linesMatch) {
      const [, varName, s, e] = linesMatch;
      const check = checkLinesHunting(varName, parseInt(s), parseInt(e));
      if (check.blocked) return formatError(check.tip!);
      if (check.tip) retryWarning += "\n" + check.tip;
    }
  }

  const allWarnings = [traitWarning, retryWarning].filter(Boolean).join('\n\n');

  // Execute appropriate mode
  if (code) {
    // Code mode: returns McpResult directly
    const result = await executeCode(ctx, code, storeAs);
    
    // Track success/failure
    if (sig) {
      if (result.isError) {
        const errText = result.content?.[0]?.type === "text" ? result.content[0].text : "Unknown error";
        recordFailure(sig, errText.slice(0, 200));
      } else {
        clearFailure(sig);
        trackMethodUsage(code, ctx.adapterContext);
      }
    }
    
    // Append warnings if any
    if (allWarnings && result.content?.[0]?.type === "text") {
      result.content[0].text = allWarnings + "\n\n" + result.content[0].text;
    }
    return result;
  }

  // Shell/Python mode: returns ShellResult or McpResult (validation error)
  const execResult = shell 
    ? await executeShell(ctx, shell, { storeAs, timeout })
    : await executePython(ctx, python!, { storeAs, timeout });
  
  // Validation error -> return directly
  if ('isError' in execResult || 'content' in execResult) {
    return execResult as McpResult;
  }

  // ShellResult -> decide indexing + format
  const { output, lines, exitCode, varName, truncated, errorMsg } = execResult;
  const truncateWarning = truncated ? '\n⚠️ Output truncated (100MB limit)' : '';

  // Classify exit code (soft fail for grep/diff/find exit 1 with output)
  const exitResult = classifyExit(exitCode, output, errorMsg || '', shell || 'python');
  if (exitResult.isError) {
    const prefix = shell ? '✗' : '✗ Python';
    return `${prefix} ${exitResult.output}${truncateWarning}\n\n✓ Stored ${varName}`;
  }

  // Intent search for large output
  if (intent && output.length > INTENT_THRESHOLD) {
    return handleLargeOutput(ctx, output, intent, varName);
  }

  const warning = allWarnings ? allWarnings + '\n\n' : '';
  
  // Small output -> apply filters and show directly
  if (output.length <= INTENT_THRESHOLD) {
    const filtered = applyHybridFilter(shell || 'python', output, [detectAndFormatGrepOutput]);
    return warning + filtered + truncateWarning;
  }
  
  // Large output -> index and show label
  const label = `exec:${varName}`;
  ctx.contentStore.index(output, label, { contentType: "plaintext" });
  return warning + `Indexed ${lines} lines as "${label}"\n-> mcx_search({ queries: [...], source: "${label}" })` + truncateWarning;
}
// ============================================================================
// Adapter Summary for Description
// ============================================================================

function buildAdapterSummary(spec: ResolvedSpec | null): string {
  if (!spec?.adapters?.length) return "No adapters loaded";

  const byDomain = new Map<string, string[]>();
  for (const a of spec.adapters) {
    const domain = a.domain || "general";
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(`${a.name}(${a.methods?.length || 0})`);
  }

  return Array.from(byDomain.entries())
    .map(([domain, adapters]) => `[${domain}] ${adapters.join(", ")}`)
    .join("\n");
}

// ============================================================================
// Tool Definition
// ============================================================================

export function createExecuteTool(spec: ResolvedSpec | null): ToolDefinition<ExecuteParams> {
  const adapterSummary = buildAdapterSummary(spec);

  return {
    name: "mcx_execute",
    description: `Execute JS/TS code, shell commands, or Python. NOT for file operations.

Code execution:
- mcx_execute({ code: "2 + 2" }) - JS/TS
- mcx_execute({ shell: "npm test" }) - shell
- mcx_execute({ python: "print('hi')" }) - Python
- mcx_execute({ code: "api.list()", storeAs: "data" }) - store as $data

File operations redirect to mcx_file (read/write/edit files).

Adapters (globals): ${adapterSummary}
Use mcx_search({ adapter: "name" }) for method details.

Data helpers: pick, keys, values, paths, tree
Variables: auto-stored as $result, use storeAs for custom name
Clear: { clear: true } or { delete: "varName" }
Large output: use intent to auto-index and search.`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS/TS code to execute" },
        shell: { type: "string", description: "Shell command to run" },
        python: { type: "string", description: "Python code to execute" },
        storeAs: { type: "string", description: "Store result as variable" },
        intent: { type: "string", description: "Auto-index large output" },
        clear: { type: "boolean", description: "Clear all variables" },
        delete: { type: "string", description: "Delete specific variable (e.g., 'result' deletes $result)" },
        // Truncation params with defaults (from bd0245e)
        truncate: { type: "boolean", default: true, description: "Truncate large results" },
        maxItems: { type: "number", minimum: 1, maximum: 1000, default: 10, description: "Max array items" },
        maxStringLength: { type: "number", minimum: 10, maximum: 10000, default: 500, description: "Max string length" },
        timeout: { type: "number", minimum: 1000, maximum: 300000, default: 30000, description: "Timeout in ms" },
      },
    },
    handler: handleExecute,
  };
}

export default createExecuteTool;
