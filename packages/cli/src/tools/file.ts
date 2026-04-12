/**
 * mcx_file Tool
 * 
 * Process file with code. Supports JavaScript (default), shell, and Python.
 * Use storeAs to read files, then query with helpers.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, basename, extname } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export interface FileParams {
  path: string;
  code?: string;
  language?: "js" | "shell" | "python";
  intent?: string;
  storeAs?: string;
}

interface FileContent {
  text: string;
  lines: string[];
  path: string;
}

// ============================================================================
// File Resolution
// ============================================================================

async function resolveFilePath(
  ctx: ToolContext,
  pathInput: string
): Promise<{ path: string; content: string } | McpResult> {
  // Try absolute or relative path first
  const tryPath = isAbsolute(pathInput) 
    ? pathInput 
    : resolve(ctx.basePath, pathInput);
  
  try {
    const content = await readFile(tryPath, "utf-8");
    return { path: tryPath, content };
  } catch (err) {
    if (!ctx.finder) {
      return formatError(`File not found: ${pathInput}`);
    }
    
    // Fuzzy search fallback
    const results = ctx.finder.fileSearch(pathInput, { pageSize: 3 });
    if (!results.ok || results.value.length === 0) {
      return formatError(`File not found: ${pathInput}`);
    }
    
    const bestMatch = results.value[0].item;
    try {
      const content = await readFile(bestMatch.path, "utf-8");
      return { path: bestMatch.path, content };
    } catch {
      return formatError(`Cannot read: ${bestMatch.path}`);
    }
  }
}

// ============================================================================
// Store Mode (storeAs without code)
// ============================================================================

function parseFileContent(content: string, path: string): FileContent {
  const lines = content.split("\n").map((l, i) => `${i + 1}: ${l}`);
  return { text: lines.join("\n"), lines, path };
}

function storeVariable(
  ctx: ToolContext,
  name: string,
  value: unknown,
  source: string
): void {
  ctx.variables.stored.set(name, {
    value,
    timestamp: Date.now(),
    source,
  });
}

function handleStoreMode(
  ctx: ToolContext,
  content: string,
  path: string,
  storeAs: string
): McpResult {
  const parsed = parseFileContent(content, path);
  const lineCount = parsed.lines.length;
  
  // Store as variable
  storeVariable(ctx, storeAs, parsed, `mcx_file:${basename(path)}`);
  
  // Track for stale detection
  ctx.workflow.proximityContext.recentFiles.push(path);
  
  return formatToolResult(
    `Stored $${storeAs} (${lineCount} lines)\n\n` +
    `💡 Use helpers: grep($${storeAs}, 'pattern'), lines($${storeAs}, start, end)`
  );
}

// ============================================================================
// Code Execution
// ============================================================================

async function executeJsCode(
  ctx: ToolContext,
  code: string,
  content: string,
  path: string
): Promise<unknown> {
  // Parse JSON files
  let fileVar: unknown;
  if (extname(path) === ".json") {
    try {
      const parsed = JSON.parse(content);
      parsed.__raw = content;
      fileVar = parsed;
    } catch {
      fileVar = parseFileContent(content, path);
    }
  } else {
    fileVar = parseFileContent(content, path);
  }
  
  const result = await ctx.sandbox.execute(code, { $file: fileVar });
  return result.value;
}

async function executeShellCode(
  ctx: ToolContext,
  code: string,
  path: string
): Promise<unknown> {
  const wrappedCode = `
    const FILE_PATH = ${JSON.stringify(path)};
    const $FILE_PATH = FILE_PATH;
    ${code.includes("$FILE_PATH") ? code : `await $\`${code}\``}
  `;
  const result = await ctx.sandbox.execute(wrappedCode, {});
  return result.value;
}

async function executePythonCode(
  ctx: ToolContext,
  code: string,
  path: string
): Promise<unknown> {
  const pythonCode = `
FILE_PATH = "${path.replace(/\\/g, "/")}"
${code}
`;
  const wrappedCode = `await $\`python -c ${JSON.stringify(pythonCode)}\``;
  const result = await ctx.sandbox.execute(wrappedCode, {});
  return result.value;
}

async function executeCode(
  ctx: ToolContext,
  code: string,
  content: string,
  path: string,
  language: "js" | "shell" | "python"
): Promise<unknown> {
  switch (language) {
    case "shell": return executeShellCode(ctx, code, path);
    case "python": return executePythonCode(ctx, code, path);
    default: return executeJsCode(ctx, code, content, path);
  }
}

// ============================================================================
// Output Handling
// ============================================================================

function formatOutput(value: unknown): string {
  if (value === undefined || value === null) return "(no output)";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function handleLargeOutput(
  ctx: ToolContext,
  output: string,
  intent: string
): McpResult {
  const sourceId = ctx.contentStore.index(output, intent, { contentType: "text" });
  const chunks = ctx.contentStore.getChunkCount(sourceId);
  
  return formatToolResult(
    `Output indexed (${chunks} chunks)\n→ mcx_search({ queries: [...] }) to search`
  );
}

// ============================================================================
// Main Handler
// ============================================================================

async function handleFile(
  ctx: ToolContext,
  params: FileParams
): Promise<McpResult> {
  const { path: pathInput, code, language = "js", intent, storeAs } = params;
  
  if (!pathInput) {
    return formatError("Missing path parameter");
  }
  
  // Resolve file
  const resolved = await resolveFilePath(ctx, pathInput);
  if ("content" in resolved === false) return resolved; // Error result
  
  const { path, content } = resolved;
  
  // Store mode (no code)
  if (!code && storeAs) {
    return handleStoreMode(ctx, content, path, storeAs);
  }
  
  // Must have code for processing
  if (!code) {
    return formatError(
      "Must use storeAs to read files\n" +
      `💡 mcx_file({ path: "${pathInput}", storeAs: "x" }), then grep($x, 'pattern')`
    );
  }
  
  // Execute code
  try {
    const result = await executeCode(ctx, code, content, path, language);
    const output = formatOutput(result);
    
    // Store result if requested
    if (storeAs) {
      storeVariable(ctx, storeAs, result, `mcx_file:${basename(path)}`);
    }
    
    // Index large output
    if (intent && output.length > 5000) {
      return handleLargeOutput(ctx, output, intent);
    }
    
    return formatToolResult(output.slice(0, 10000));
  } catch (err) {
    return formatError(`Execution failed: ${String(err)}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxFile: ToolDefinition<FileParams> = {
  name: "mcx_file",
  description: `Process file with code. Supports JavaScript (default), shell, and Python.

**IMPORTANT: Use storeAs to read files, then query with helpers.**
- mcx_file({ path, storeAs: "x" }) → then grep($x, 'pattern'), lines($x, 10, 20)
- WRONG: mcx_file({ path, code: "grep($file, ...)" }) ← use storeAs first

Supports fuzzy paths - partial names are resolved via FFF:
- mcx_file({ path: "serve", code: "..." }) → serve.ts

## JavaScript (default)
File content available as $file.
- mcx_file({ path: "data.json", code: "$file.items.length" })
- mcx_file({ path: "config.yaml", code: "$file.lines.filter(l => l.includes('port'))" })

## Shell
File path available as $FILE_PATH.
- mcx_file({ path: "data.csv", language: "shell", code: "wc -l $FILE_PATH" })

## Python
File path available as FILE_PATH variable.
- mcx_file({ path: "data.csv", language: "python", code: "import pandas as pd; df = pd.read_csv(FILE_PATH); print(df.describe())" })

**Tips:**
- Helpers (JS only, use after storeAs): around(), lines(), grep(), block(), outline()
- For edits: find line numbers with grep(), then use mcx_edit line mode`,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to process" },
      code: { type: "string", description: "Code to process file" },
      language: {
        type: "string",
        enum: ["js", "shell", "python"],
        description: "Execution language (default: js)",
      },
      intent: { type: "string", description: "Auto-index if output > 5KB" },
      storeAs: { type: "string", description: "Store result as variable" },
    },
    required: ["path"],
  },
  handler: handleFile,
  needsFinder: true,
};

export default mcxFile;
