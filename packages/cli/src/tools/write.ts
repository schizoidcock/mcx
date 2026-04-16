/**
 * mcx_write Tool
 * 
 * Create or overwrite a file.
 * Bypasses native Write's "must read first" requirement.
 */

import { basename, isAbsolute, join } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError } from "./utils.js";
import { recordEdit } from "../context/files.js";

// ============================================================================
// Types
// ============================================================================

export interface WriteParams {
  file_path?: string;
  path?: string;
  content: string;
}

// ============================================================================
// Handler
// ============================================================================

async function handleWrite(
  ctx: ToolContext,
  params: WriteParams
): Promise<McpResult> {
  const { file_path, path, content } = params;
  const filePath = file_path || path;
  
  // Validate
  if (!filePath) {
    return formatError("Missing file_path or path parameter");
  }
  if (content === undefined || content === null) {
    return formatError("Missing content parameter");
  }
  
  try {
    // Require absolute path (consistent with mcx_edit)
    if (!isAbsolute(filePath)) {
      return formatError(`Absolute path required. Got: "${filePath}"`);
    }
    const resolvedPath = filePath;
    
    // Write file
    await Bun.write(resolvedPath, content);
    
    // Track edit timestamp for stale detection (context/files.ts owns this)
    recordEdit(resolvedPath);
    
    // Format result
    const lineCount = content.split("\n").length;
    const fileName = basename(resolvedPath);
    
    return `✓ Wrote ${lineCount} lines to ${fileName}\n💡 No need to re-read to verify.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatError(`Failed to write file: ${msg}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxWrite: ToolDefinition<WriteParams> = {
  name: "mcx_write",
  description: `Create or overwrite a file. Bypasses native Write's "must read first" requirement.

Example:
mcx_write({ file_path: "/path/to/file.ts", content: "const x = 1;" })

Tip: For partial edits, use mcx_edit instead (preserves existing content).`,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      path: {
        type: "string",
        description: "Alias for file_path",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["content"],
  },
  handler: handleWrite,
};

export default mcxWrite;
