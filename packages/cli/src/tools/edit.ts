/**
 * mcx_edit Tool
 *
 * Edit a file. Two modes:
 * - Line mode: replace by line numbers (PREFERRED - minimal tokens)
 * - String mode: find and replace text
 */

import { isAbsolute, resolve } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError } from "./utils.js";
import { normalizePath } from "../utils/paths.js";
import { trackToolUsage, suggestNextTool } from "../context/tracking.js";
import { getFileEditTime } from "./write.js";
import { getSandboxState } from "../sandbox/index.js";
import { checkBraceBalance } from "../utils/syntax.js";

// ============================================================================
// Types
// ============================================================================

export interface EditParams {
  file_path?: string;
  path?: string;
  start?: number;
  end?: number;
  old_string?: string;
  new_string: string;
  replace_all?: boolean;
}

// ============================================================================
// State Accessors (delegate to PersistentState - ONE source of truth)
// ============================================================================

export function setFileStoreTime(path: string, _time: number): void {
  // Note: time param ignored - state.setFileVar() sets timestamp internally
  // This is kept for API compatibility but callers should use state directly
}

export function getFileStoreTime(path: string): number | undefined {
  return getSandboxState().getFileStoreTime(path);
}



export function getEditTime(path: string): number | undefined {
  return getSandboxState().getEditTime(path);
}
// ============================================================================
// Handler
// ============================================================================

async function handleEdit(ctx: ToolContext, params: EditParams): Promise<McpResult> {
  const filePathRaw = params.file_path || params.path;
  const { start, end, replace_all = false } = params;
  
  // Normalize: path backslash→forward, strings trimEnd
  const filePath = filePathRaw ? normalizePath(filePathRaw) : undefined;
  const old_string = params.old_string?.trimEnd();
  const new_string = params.new_string?.trimEnd();

  if (!filePath) return formatError("Missing file_path or path parameter");
  if (new_string === undefined) return formatError("Missing new_string parameter");

  // Require absolute path (no fuzzy - ambiguous with multiple files named the same)
  if (!isAbsolute(filePath)) {
    return formatError(`Absolute path required. Got: "${filePathRaw}"`);
  }
  const resolvedPath = normalizePath(resolve(filePath));

  try {
    const file = Bun.file(resolvedPath);
    if (!await file.exists()) return formatError(`File not found: ${resolvedPath}`);

    const content = await file.text();
    const lines = content.split("\n");
    let newContent: string;
    let isAppend = false;
    let editStartLine = 1;
    let editEndLine = lines.length;

    if (start !== undefined && end !== undefined) {
      const state = getSandboxState();
      const storeTime = state.getFileStoreTime(resolvedPath);
      const editTime = state.getEditTime(resolvedPath);
      const writeTime = getFileEditTime(resolvedPath);

      if (storeTime && (editTime && editTime > storeTime) || (writeTime && writeTime > (storeTime || 0))) {
        return formatError(`File may have changed since last read. Re-read with mcx_file({ storeAs }) before editing.`);
      }

      if (start < 1 || end < start) return formatError(`Invalid line range: ${start}-${end}`);

      if (start === lines.length + 1 && end === lines.length + 1) {
        isAppend = true;
        newContent = content + (content.endsWith("\n") ? "" : "\n") + new_string;
      } else if (start > lines.length || end > lines.length) {
        return formatError(`Line range ${start}-${end} exceeds file length (${lines.length} lines)`);
      } else {
        const before = lines.slice(0, start - 1);
        const after = lines.slice(end);
        newContent = [...before, new_string, ...after].join("\n");
        editStartLine = start;
        editEndLine = end;
      }
    } else if (old_string !== undefined) {
      if (old_string === new_string) return formatError("old_string and new_string are identical");

      // CRLF handling (R.8.37): normalize to LF, do replacement, restore CRLF if needed
      const hasCRLF = content.includes('\r\n');
      const contentLF = content.replace(/\r\n/g, '\n');
      const oldLF = old_string.replace(/\r\n/g, '\n');
      const newLF = new_string.replace(/\r\n/g, '\n');

      const count = contentLF.split(oldLF).length - 1;
      if (count === 0) return formatError(`old_string not found in file. Verify the exact text exists.`);

      if (count > 1 && !replace_all) {
        const matchLines: number[] = [];
        let pos = 0, idx = contentLF.indexOf(oldLF, pos);
        while (idx !== -1) {
          matchLines.push(contentLF.slice(0, idx).split("\n").length);
          pos = idx + 1;
          idx = contentLF.indexOf(oldLF, pos);
        }
        return formatError(`old_string found ${count} times (lines: ${matchLines.join(", ")}). Use replace_all: true or provide more context.`);
      }

      // Do replacement in LF mode, then restore CRLF if original had it
      const resultLF = replace_all ? contentLF.replaceAll(oldLF, newLF) : contentLF.replace(oldLF, newLF);
      newContent = hasCRLF ? resultLF.replace(/\n/g, '\r\n') : resultLF;
      
      const oldIdx = contentLF.indexOf(oldLF);
      if (oldIdx >= 0) {
        editStartLine = contentLF.slice(0, oldIdx).split("\n").length;
        editEndLine = editStartLine + oldLF.split("\n").length - 1;
      }
    } else {
      return formatError("Must provide either line range (start, end) or old_string for replacement");
    }

    // TODO: Fix checkBraceBalance for nested template strings
    // const result = checkBraceBalance(newContent);
    // if (result.balance !== 0) {
    //   const lines = result.balance > 0 
    //     ? `Unclosed { at lines: ${result.unclosedLines.join(', ')}`
    //     : `Unmatched } at lines: ${result.unmatchedLines.join(', ')}`;
    //   return formatError(`File has unbalanced braces (${Math.abs(result.balance)})\n${lines}`);
    // }

    await Bun.write(resolvedPath, newContent);
    getSandboxState().setEditTime(resolvedPath);
    trackToolUsage("mcx_edit", resolvedPath);

    const fileName = normalizePath(resolvedPath);
    const editedLines = newContent.split("\n").length;
    const action = isAppend ? "Appended to" : "Edited";
    const lineInfo = isAppend ? `(appended after line ${lines.length})` : `(lines ${editStartLine}-${editEndLine})`;
    const nextTool = suggestNextTool("mcx_edit", { filePath: resolvedPath });
    const suggestion = nextTool ? `\n💡 ${nextTool.tool}: ${nextTool.hint}` : "";

    return { content: [{ type: "text", text: `✓ ${action} ${fileName} ${lineInfo}\n${editedLines} total lines${suggestion}` }] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return formatError(`Edit failed: ${msg}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxEdit: ToolDefinition<EditParams> = {
  name: "mcx_edit",
  description: `Edit a file. Two modes:

**Line mode** (PREFERRED - minimal tokens):
mcx_edit({ file_path, start: 10, end: 12, new_string: "new content" })

**String mode** (fallback):
mcx_edit({ file_path, old_string: "unique text", new_string: "replacement" })

**Workflow:** mcx_file({ storeAs }) → grep/around to find lines → mcx_edit({ start, end })`,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to edit" },
      path: { type: "string", description: "Alias for file_path" },
      start: { type: "number", minimum: 1, description: "Line mode: start line (1-indexed)" },
      end: { type: "number", minimum: 1, description: "Line mode: end line (1-indexed, inclusive)" },
      old_string: { type: "string", description: "String mode: exact string to find and replace" },
      new_string: { type: "string", description: "The replacement string/content" },
      replace_all: { type: "boolean", description: "String mode: replace all occurrences", default: false },
    },
  },
  handler: handleEdit,

};

export default mcxEdit;
