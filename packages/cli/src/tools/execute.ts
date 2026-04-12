/**
 * mcx_execute Tool
 * 
 * Execute JavaScript/TypeScript code OR shell commands.
 * Supports adapters, file helpers, and variable management.
 */

import type { ToolContext, ToolDefinition, McpResult, AdapterSpec } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";

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
  // Inject variables into sandbox context
  const context: Record<string, unknown> = {};
  
  // Add stored variables
  for (const [name, entry] of ctx.variables.stored) {
    context[`$${name}`] = entry.value;
  }
  
  // Add last result as $result
  if (ctx.variables.lastResult !== undefined) {
    context.$result = ctx.variables.lastResult;
  }
  
  try {
    const result = await ctx.sandbox.execute(code, context);
    const value = result.value;
    
    // Store result
    ctx.variables.lastResult = value;
    if (storeAs) {
      ctx.variables.stored.set(storeAs, {
        value,
        timestamp: Date.now(),
        source: "mcx_execute",
      });
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
  // Wrap shell command in Bun's $ template literal
  const code = `await $\`${command}\``;
  
  try {
    const result = await ctx.sandbox.execute(code, {});
    const value = result.value;
    
    // Store if requested
    if (storeAs) {
      ctx.variables.stored.set(storeAs, {
        value,
        timestamp: Date.now(),
        source: `mcx_execute:shell`,
      });
    }
    
    const output = formatShellOutput(value);
    return formatToolResult(output);
  } catch (err) {
    return formatError(`Shell command failed: ${String(err)}`);
  }
}

function formatShellOutput(value: unknown): string {
  if (value === undefined || value === null) return "(no output)";
  
  // Shell output is usually text
  const text = typeof value === "string" 
    ? value 
    : JSON.stringify(value, null, 2);
  
  // Truncate long outputs
  return text.length > 10000 
    ? text.slice(0, 10000) + "\n... [truncated]" 
    : text;
}

// ============================================================================
// Python Execution (Mode 3)
// ============================================================================

async function executePython(
  ctx: ToolContext,
  pythonCode: string,
  storeAs?: string
): Promise<McpResult> {
  const wrappedCode = `await $\`python -c ${JSON.stringify(pythonCode)}\``;
  
  try {
    const result = await ctx.sandbox.execute(wrappedCode, {});
    const value = result.value;
    
    // Store if requested
    if (storeAs) {
      ctx.variables.stored.set(storeAs, {
        value,
        timestamp: Date.now(),
        source: `mcx_execute:python`,
      });
    }
    
    const output = formatValue(value);
    return formatToolResult(output);
  } catch (err) {
    return formatError(`Python execution failed: ${String(err)}`);
  }
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
