/**
 * mcx_execute Tool
 *
 * Execute JavaScript/TypeScript code OR shell commands.
 * Supports adapters, file helpers, and variable management.
 */

import type { ToolContext, ToolDefinition, McpResult, AdapterSpec } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";

// ============================================================================
// Shell Constants
// ============================================================================

const SHELL_PATH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\sh.exe'
  : '/bin/sh';

const DENIED_ENV = new Set([
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GITHUB_TOKEN',
  'NPM_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL',
]);

let cachedSafeEnv: Record<string, string> | null = null;

function getSafeEnv(): Record<string, string> {
  if (cachedSafeEnv) return cachedSafeEnv;
  const safeEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && !DENIED_ENV.has(key) && !key.includes('SECRET') && !key.includes('PASSWORD') && !key.includes('TOKEN') && !key.includes('CREDENTIAL')) {
      safeEnv[key] = value;
    }
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
}

// ============================================================================
// Code Execution (Mode 1)
// ============================================================================

async function executeCode(
  ctx: ToolContext,
  code: string,
  storeAs?: string
): Promise<McpResult> {
  // Build variables from stored state
  // PersistentState.getAllPrefixed() returns { $name: value } format
  let variables: Record<string, unknown> = {};
  try {
    const stored = ctx.variables.stored as any;
    if (stored && typeof stored.getAllPrefixed === 'function') {
      variables = { ...stored.getAllPrefixed() };
    }
  } catch {
    // Ignore errors getting variables
  }

  // Add last result as $result
  if (ctx.variables.lastResult !== undefined) {
    variables.$result = ctx.variables.lastResult;
  }

  try {
    // Prepend file helpers so grep(), lines(), etc. are available
    const helpers = ctx.fileHelpersCode || '';
    const fullCode = helpers + code;
    
    // Sandbox expects { adapters, variables, env } structure
    const result = await ctx.sandbox.execute(fullCode, {
      adapters: {},
      variables,
      env: {},
    });
    const value = result.value;

    // Store result via PersistentState.set() if available
    ctx.variables.lastResult = value;
    if (storeAs) {
      if (typeof stored.set === 'function') {
        stored.set(storeAs, value);
      }
    }

    // Format output
    const output = formatValue(value);
    const storedMsg = storeAs ? `\n\nStored as $${storeAs}` : "";

    return formatToolResult(output + storedMsg);
  } catch (err) {
    return formatError(`Execution failed: ${String(err)}`);
  }
}

function formatValue(value: unknown): string {
  if (value === undefined) return "(undefined)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value;

  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 5000 ? json.slice(0, 5000) + "\n... [truncated]" : json;
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
  storeAs?: string
): Promise<McpResult> {
  const cmd = command.trim();
  if (!cmd) return formatError("Empty command");

  const proc = Bun.spawn([SHELL_PATH, '-c', cmd], {
    cwd: process.cwd(),
    env: getSafeEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const result = { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), command: cmd };

  // Store result
  const stored = ctx.variables.stored as any;
  stored.set?.('result', result);
  if (storeAs) stored.set?.(storeAs, result);

  // Format output
  const status = exitCode === 0 ? '✓' : `✗ Exit ${exitCode}`;
  const output = stdout.trim() || stderr.trim() || '(no output)';
  return formatToolResult(`${status}\n${output}`);
}

// ============================================================================
// Python Execution (Mode 3)
// ============================================================================

async function executePython(
  ctx: ToolContext,
  code: string,
  storeAs?: string
): Promise<McpResult> {
  const pythonCode = code.trim();
  if (!pythonCode) return formatError("Empty Python code");

  const pythonPath = process.platform === 'win32' ? 'python' : 'python3';
  const proc = Bun.spawn([pythonPath, '-c', pythonCode], {
    cwd: process.cwd(),
    env: getSafeEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  const result = { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };

  // Store result
  const stored = ctx.variables.stored as any;
  stored.set?.('result', result);
  if (storeAs) stored.set?.(storeAs, result);

  // Format output
  const status = exitCode === 0 ? '✓ Python' : `✗ Exit ${exitCode}`;
  const output = stdout.trim() || stderr.trim() || '(no output)';
  return formatToolResult(`${status}\n${output}`);
}

// ============================================================================
// Intent-based Indexing
// ============================================================================

function handleLargeOutput(
  ctx: ToolContext,
  output: string,
  intent: string
): McpResult {
  const sourceId = ctx.contentStore.index(output, intent, { contentType: "text" });
  const chunks = ctx.contentStore.getChunkCount(sourceId);

  return formatToolResult(
    `Output indexed: ${intent} (${chunks} chunks)\n` +
    `→ mcx_search({ queries: [...] }) to search results`
  );
}

// ============================================================================
// Main Handler
// ============================================================================

async function handleExecute(
  ctx: ToolContext,
  params: ExecuteParams
): Promise<McpResult> {
  const { code, shell, python, storeAs, intent } = params;

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

  // Execute appropriate mode
  let result: McpResult;

  if (code) {
    result = await executeCode(ctx, code, storeAs);
  } else if (shell) {
    result = await executeShell(ctx, shell, storeAs);
  } else {
    result = await executePython(ctx, python!, storeAs);
  }

  // Handle large output indexing
  if (intent && !result.isError) {
    const text = result.content?.[0];
    if (text?.type === "text" && text.text.length > 5000) {
      return handleLargeOutput(ctx, text.text, intent);
    }
  }

  return result;
}

// ============================================================================
// Adapter Summary for Description
// ============================================================================

function buildAdapterSummary(spec: AdapterSpec | null): string {
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

export function createExecuteTool(spec: AdapterSpec | null): ToolDefinition<ExecuteParams> {
  const adapterSummary = buildAdapterSummary(spec);

  return {
    name: "mcx_execute",
    description: `Execute JavaScript/TypeScript code OR shell commands.

## Mode 1: Code Execution (code parameter)
NOT for file/content search - use mcx_find (files) or mcx_grep (content) instead.

### Calling Adapters
Adapters are available as globals. Use camelCase for names with hyphens:
- supabase.list_projects()
- chromeDevtools.listPages()  // chrome-devtools → chromeDevtools

### Available Adapters
${adapterSummary}

Use mcx_search({ adapter: "name" }) for method details.

### Built-in Helpers
- pick(arr, ['id', 'name']) - Extract fields
- first(arr, 5) - First N items
- count(arr, 'field') - Count by field
- sum(arr, 'field') - Sum numeric field

### File Helpers (require mcx_file storeAs first!)
WRONG: mcx_execute({ code: "grep($file, 'pattern')" }) ← $file undefined
RIGHT: mcx_file({ path, storeAs: "f" }) THEN mcx_execute({ code: "grep($f, 'pattern')" })

Available after storeAs: grep($var, pattern), lines($var, start, end), around($var, line, ctx), block($var, line), outline($var)

### Variables
- Results auto-stored as $result
- storeAs: "name" → $name
- $clear: Clear all
- delete $varname: Delete specific variable

## Mode 2: Shell Execution (shell parameter)
Run system commands with proper timeout and output capture.
- { shell: "npm test" }
- { shell: "git status" }
- { shell: "docker ps -a", storeAs: "containers" }

## Mode 3: Python Execution (python parameter)
Run Python code with proper timeout.
- { python: "print(2 + 2)" }
- { python: "import json; print(json.dumps({'a': 1}))" }

## Large Output Handling
- intent: Auto-index output >5KB and search. Returns snippets instead of full data.`,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "JS/TS code to execute" },
        shell: { type: "string", description: "Shell command to run" },
        python: { type: "string", description: "Python code to execute" },
        storeAs: { type: "string", description: "Store result as variable" },
        intent: { type: "string", description: "Auto-index large output" },
      },
    },
    handler: handleExecute,
  };
}

export default createExecuteTool;
