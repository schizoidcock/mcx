/**
 * mcx_find Tool
 * 
 * Find FILES by name. NOT for searching content inside files.
 * Use mcx_grep for content search.
 */

import { resolve } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatToolResult, formatError, compactPath } from "./utils.js";
import { trackToolUsage, updateProximityContext } from "../context/tracking.js";
import { initializeFinder, getFinderForPath } from "../context/create.js";

// ============================================================================
// Types
// ============================================================================

export interface FindParams {
  query?: string;
  pattern?: string;  // Alias for query
  path?: string;     // Directory to search
  related?: string;  // Find related files (imports/importers)
  limit?: number;    // Max results
}

// ============================================================================
// Handler
// ============================================================================

async function handleFind(
  ctx: ToolContext,
  params: FindParams
): Promise<McpResult> {
  const query = params.query || params.pattern;
  const limit = params.limit || 20;
  
  // Related files mode
  if (params.related) {
    return handleFindRelated(ctx, params.related);
  }
  
  if (!query) {
    return formatError(
      "Missing query or pattern parameter",
      "Example: mcx_find({ query: '*.ts' }) or mcx_find({ related: 'file.ts' })"
    );
  }
  
  // Get finder for search path
  const searchPath = params.path ? resolve(params.path) : ctx.basePath;
  
  try {
    const finder = await getFinderForPath(ctx, searchPath);
    
    // Execute search
    const results = finder.findFiles(query, { maxResults: limit * 2 });
    
    if (!results.ok) {
      return formatError(`Search failed: ${results.error}`);
    }
    
    const files = results.value.files;
    
    // Track usage
    trackToolUsage("mcx_find");
    
    // Update proximity context
    updateProximityContext(
      files.slice(0, 5).map(f => f.relativePath),
      [query]
    );
    
    // No matches
    if (files.length === 0) {
      return formatToolResult(
        `No files matching "${query}"`,
        "\n→ Try: broader pattern or different path"
      );
    }
    
    // Format output
    const toShow = files.slice(0, limit);
    const hidden = files.length - toShow.length;
    
    const lines: string[] = [];
    lines.push(`Found ${files.length} files${hidden > 0 ? ` (showing ${limit}, +${hidden} hidden)` : ""}:`);
    lines.push("");
    
    for (const file of toShow) {
      let line = file.relativePath;
      
      // Add git status if available
      if (file.status) {
        const statusIcon = file.status === "modified" ? "★" 
          : file.status === "untracked" ? "[untracked]" 
          : "";
        if (statusIcon) line += ` ${statusIcon}`;
      }
      
      lines.push(line);
    }
    
    return formatToolResult(
      lines.join("\n"),
      `\n→ Next: mcx_file({ path: "${toShow[0]?.relativePath}" })`
    );
    
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatError(`Find failed: ${msg}`);
  }
}

// ============================================================================
// Related Files
// ============================================================================

async function handleFindRelated(
  ctx: ToolContext,
  targetFile: string
): Promise<McpResult> {
  try {
    const finder = await initializeFinder(ctx);
    
    // Find the file first
    const fileResult = finder.findFiles(targetFile, { maxResults: 1 });
    if (!fileResult.ok || fileResult.value.files.length === 0) {
      return formatError(`File not found: ${targetFile}`);
    }
    
    const file = fileResult.value.files[0];
    
    // Get related files (imports, importers, siblings)
    const related = finder.findRelated(file.relativePath);
    
    if (!related.ok) {
      return formatError(`Could not find related files: ${related.error}`);
    }
    
    const { imports, importers, siblings } = related.value;
    
    // Track usage
    trackToolUsage("mcx_find", targetFile);
    
    // Format output
    const lines: string[] = [];
    lines.push(`Related files for: ${file.relativePath}`);
    lines.push("");
    
    if (imports.length > 0) {
      lines.push(`Imports (${imports.length}):`);
      for (const imp of imports.slice(0, 10)) {
        lines.push(`  → ${imp}`);
      }
      if (imports.length > 10) {
        lines.push(`  ... +${imports.length - 10} more`);
      }
      lines.push("");
    }
    
    if (importers.length > 0) {
      lines.push(`Imported by (${importers.length}):`);
      for (const imp of importers.slice(0, 10)) {
        lines.push(`  ← ${imp}`);
      }
      if (importers.length > 10) {
        lines.push(`  ... +${importers.length - 10} more`);
      }
      lines.push("");
    }
    
    if (siblings.length > 0) {
      lines.push(`Siblings (${siblings.length}):`);
      for (const sib of siblings.slice(0, 5)) {
        lines.push(`  - ${sib}`);
      }
      if (siblings.length > 5) {
        lines.push(`  ... +${siblings.length - 5} more`);
      }
    }
    
    if (imports.length === 0 && importers.length === 0 && siblings.length === 0) {
      lines.push("No related files found.");
    }
    
    return formatToolResult(lines.join("\n"));
    
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatError(`Find related failed: ${msg}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxFind: ToolDefinition<FindParams> = {
  name: "mcx_find",
  description: `Find FILES by name. NOT for searching content inside files.

USE THIS FOR: "where is config.ts?", "find all *.test.ts files"
DO NOT USE FOR: "find useState in code" → use mcx_grep instead

Query syntax:
- "config.ts" - Find file by name
- "*.ts" - All TypeScript files
- "!test" - Exclude test files
- "src/" - Files in src directory
- "status:modified" - Git modified files

Related files mode:
- mcx_find({ related: "serve.ts" }) - Find imports, importers, and siblings`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "File name or pattern to search for",
      },
      pattern: {
        type: "string",
        description: "Alias for query (for compatibility)",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current project)",
      },
      related: {
        type: "string",
        description: "Find files related to this file (imports, importers, siblings)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results",
        default: 20,
      },
    },
  },
  handler: handleFind,
  needsFinder: true,
};

export default mcxFind;
