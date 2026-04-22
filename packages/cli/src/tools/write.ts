/**
 * mcx_write Tool
 * 
 * Create or overwrite a file.
 * Bypasses native Write's "must read first" requirement.
 */

import { basename, isAbsolute } from "node:path";
import { readFile } from "node:fs/promises";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError, diffSummary } from "./utils.js";
import { recordEdit } from "../context/files.js";
import { validateWriteContent } from "./file.js";

// ============================================================================
// Types
// ============================================================================

export interface WriteParams {
  file_path?: string;
  path?: string;
  content: string;
}

// ============================================================================
// Helpers
// ============================================================================

function validateWriteParams(params: WriteParams): { ok: true; filePath: string } | { ok: false; error: McpResult } {
  const { file_path, path, content } = params;
  const filePath = file_path || path;

  if (!filePath) return { ok: false, error: formatError("Missing file_path or path parameter") };
  if (content === undefined || content === null) return { ok: false, error: formatError("Missing content parameter") };
  if (!isAbsolute(filePath)) return { ok: false, error: formatError(`Absolute path required. Got: "${filePath}"`) };

  return { ok: true, filePath };
}

async function getOldContent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;  // File doesn't exist
  }
}

// ============================================================================
// Handler
// ============================================================================

async function handleWrite(
  ctx: ToolContext,
  params: WriteParams
): Promise<McpResult> {
  const validated = validateWriteParams(params);
  if (!validated.ok) return validated.error;

  const { filePath } = validated;
  const { content } = params;

  // Validate content (braces, duplicates)
  const contentValidation = validateWriteContent(content, basename(filePath));
  if (!contentValidation.ok) return contentValidation.error;

  try {
    const oldContent = await getOldContent(filePath);
    
    await Bun.write(filePath, contentValidation.content);
    recordEdit(filePath);

    const lineCount = content.split("\n").length;
    const fileName = basename(filePath);
    const diff = ` | ${diffSummary(oldContent ?? '', content)}`;

    const tip = oldContent !== null ? '\n💡 No need to re-read to verify.' : '';
    return `✓ Wrote ${lineCount} lines to ${fileName}${diff}${tip}`;
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

Tip: For partial edits, use mcx_file with write: true instead.`,
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
