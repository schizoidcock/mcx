/**
 * mcx_edit Tool
 * 
 * Edit a file. Two modes:
 * - Line mode: replace by line numbers (PREFERRED - minimal tokens)
 * - String mode: find and replace text
 */

import { basename, isAbsolute, join, resolve } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";
import { trackToolUsage, suggestNextTool } from "../context/tracking.js";
import { getFileEditTime } from "./write.js";

// ============================================================================
// Types
// ============================================================================

export interface EditParams {
  file_path?: string;
  path?: string;
  // Line mode
  start?: number;
  end?: number;
  // String mode
  old_string?: string;
  new_string: string;
  replace_all?: boolean;
}

// ============================================================================
// State
// ============================================================================

/** Track when files were stored (for stale detection) */
const fileStoreTime = new Map<string, number>();

export function setFileStoreTime(path: string, time: number): void {
  fileStoreTime.set(path, time);
}

// ============================================================================
// Brace Balance Check
// ============================================================================

function checkBraceBalance(content: string): number {
  let balance = 0;
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];
    
    // Handle newlines - reset line comment
    if (char === "\n") {
      inLineComment = false;
      escaped = false;
      continue;
    }
    
    // Skip if in comment
    if (inLineComment) continue;
    
    // Block comment handling
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    
    // Check for comment start
    if (!inString && char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (!inString && char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    
    // String handling
    if (!inString && (char === '"' || char === "'" || char === "`")) {
      inString = true;
      stringChar = char;
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
      continue;
    }
    
    // Count braces
    if (char === "{") balance++;
    if (char === "}") balance--;
  }
  
  return balance;
}

// ============================================================================
// Handler
// ============================================================================

async function handleEdit(
  ctx: ToolContext,
  params: EditParams
): Promise<McpResult> {
  const filePath = params.file_path || params.path;
  const { start, end, old_string, new_string, replace_all = false } = params;
  
  // Validate
  if (!filePath) {
    return formatError("Missing file_path or path parameter");
  }
  if (new_string === undefined) {
    return formatError("Missing new_string parameter");
  }
  
  // Resolve path
  let resolvedPath = filePath;
  if (!isAbsolute(filePath)) {
    resolvedPath = join(process.cwd(), filePath);
  }
  resolvedPath = resolve(resolvedPath);
  
  try {
    // Read current content
    const file = Bun.file(resolvedPath);
    if (!await file.exists()) {
      return formatError(`File not found: ${resolvedPath}`);
    }
    
    const content = await file.text();
    const lines = content.split("\n");
    let newContent: string;
    let isAppend = false;
    let editStartLine = 1;
    let editEndLine = lines.length;
    
    // Line mode
    if (start !== undefined && end !== undefined) {
      // Check for stale line numbers
      const storeTime = fileStoreTime.get(resolvedPath);
      const editTime = getFileEditTime(resolvedPath);
      
      if (storeTime && editTime && editTime > storeTime) {
        return formatError(
          `⚠️ File was edited since last read (stale line numbers)`,
          `Re-read with mcx_file({ path: "...", storeAs: "..." }) to get current line numbers`
        );
      }
      
      // Append mode: start > line count
      if (start > lines.length) {
        isAppend = true;
        newContent = content + (content.endsWith("\n") ? "" : "\n") + new_string;
        editStartLine = lines.length + 1;
      } else {
        // Normal line mode replacement
        const startIdx = Math.max(0, start - 1);
        const endIdx = Math.min(lines.length, end);
        
        const before = lines.slice(0, startIdx);
        const after = lines.slice(endIdx);
        const newLines = new_string.split("\n");
        
        newContent = [...before, ...newLines, ...after].join("\n");
        editStartLine = start;
        editEndLine = end;
      }
    }
    // String mode
    else if (old_string !== undefined) {
      if (old_string === new_string) {
        return formatError("old_string and new_string are identical");
      }
      
      // Normalize line endings for comparison
      const contentLF = content.replace(/\r\n/g, "\n");
      const oldLF = old_string.replace(/\r\n/g, "\n");
      const newLF = new_string.replace(/\r\n/g, "\n");
      
      // Check if old_string exists
      const firstIdx = contentLF.indexOf(oldLF);
      if (firstIdx === -1) {
        return formatError(
          "old_string not found in file",
          "Make sure the text matches exactly (including whitespace)"
        );
      }
      
      // Check for uniqueness (unless replace_all)
      if (!replace_all) {
        const secondIdx = contentLF.indexOf(oldLF, firstIdx + 1);
        if (secondIdx !== -1) {
          const lineNum1 = contentLF.slice(0, firstIdx).split("\n").length;
          const lineNum2 = contentLF.slice(0, secondIdx).split("\n").length;
          return formatError(
            `old_string appears multiple times (lines ${lineNum1} and ${lineNum2})`,
            `Use replace_all: true to replace all, or use line mode instead`
          );
        }
      }
      
      // Do replacement
      const hasCRLF = content.includes("\r\n");
      const resultLF = replace_all 
        ? contentLF.replaceAll(oldLF, newLF) 
        : contentLF.replace(oldLF, newLF);
      newContent = hasCRLF ? resultLF.replace(/\n/g, "\r\n") : resultLF;
      
      // Calculate edit start line
      editStartLine = contentLF.slice(0, firstIdx).split("\n").length;
    } else {
      return formatError(
        "Must provide either start/end (line mode) or old_string (string mode)"
      );
    }
    
    // Validate brace balance for code files
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    const codeExts = ["ts", "tsx", "js", "jsx", "json", "c", "cpp", "h", "java", "go", "rs"];
    
    if (codeExts.includes(ext)) {
      const balance = checkBraceBalance(newContent);
      if (balance !== 0) {
        return formatError(
          `Unbalanced braces: ${balance > 0 ? `${balance} unclosed {` : `${-balance} extra }`}`,
          "Check your edit for missing or extra braces"
        );
      }
    }
    
    // Write file
    await Bun.write(resolvedPath, newContent);
    
    // Track edit time
    const editTimeMap = new Map<string, number>();
    editTimeMap.set(resolvedPath, Date.now());
    
    trackToolUsage("mcx_edit", resolvedPath);
    
    // Build response
    const fileName = basename(resolvedPath);
    const newLineCount = new_string.split("\n").length;
    const changeIndicator = isAppend 
      ? "appended" 
      : `${start !== undefined ? "line mode" : "string mode"}`;
    
    const lineRange = isAppend 
      ? `L${editStartLine}+` 
      : `L${editStartLine}-${editEndLine}`;
    
    const hints = [
      "💡 No need to re-read to verify.",
    ];
    
    if (!isAppend) {
      hints.push("💡 Multiple edits? Batch them before build/test.");
    }
    
    return formatToolResult(
      `✓ ${fileName}:${lineRange} (${changeIndicator})\n${hints.join("\n")}`,
      suggestNextTool("mcx_edit")
    );
    
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
Only sends line numbers + new content. ~80% fewer tokens than string mode.

**String mode** (fallback when line numbers unknown):
mcx_edit({ file_path, old_string: "unique text", new_string: "replacement" })

**Why mcx_edit over native Edit?**
- Line mode: send 2 numbers instead of full old_string (massive token savings)
- No "must read first" requirement - edit directly if you know line numbers
- Stale line detection: warns if file changed since last storeAs

**Workflow:** mcx_file({ storeAs }) → grep/around to find lines → mcx_edit({ start, end })`,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file to edit",
      },
      path: {
        type: "string",
        description: "Alias for file_path",
      },
      start: {
        type: "number",
        description: "Line mode: start line (1-indexed)",
      },
      end: {
        type: "number",
        description: "Line mode: end line (1-indexed, inclusive)",
      },
      old_string: {
        type: "string",
        description: "String mode: exact string to find and replace",
      },
      new_string: {
        type: "string",
        description: "The replacement string/content",
      },
      code: {
        type: "string",
        description: "JS code for transform mode",
      },
      mode: {
        type: "string",
        description: "Edit mode: line, string, or transform",
      },
      replace_all: {
        type: "boolean",
        description: "String mode: replace all occurrences",
        default: false,
      },
    },
  },
  handler: handleEdit,
  needsFinder: true,
};

export default mcxEdit;
