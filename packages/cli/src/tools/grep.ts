/**
 * mcx_grep Tool
 *
 * Search CONTENT inside files.
 * NOT for finding files by name - use mcx_find instead.
 */

import { resolve } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";
import { formatGrepMCX, type GrepMatch } from "./format-grep.js";
import { trackToolUsage, updateProximityContext, getProximityScore } from "../context/tracking.js";
import { initializeFinder, getFinderForPath } from "../context/create.js";

// ============================================================================
// Types
// ============================================================================

export interface GrepParams {
  query?: string;
  pattern?: string;  // Alias for query
  path?: string;     // Directory to search
  context?: number;  // Lines of context
}

// ============================================================================
// Query Parsing
// ============================================================================

interface ParsedQuery {
  filePattern: string | null;  // e.g., "*.ts"
  searchTerm: string;          // The actual search term
  pathPrefix: string | null;   // e.g., "src/"
}

function parseGrepQuery(query: string): ParsedQuery {
  const parts = query.trim().split(/\s+/);

  let filePattern: string | null = null;
  let pathPrefix: string | null = null;
  const searchTerms: string[] = [];

  for (const part of parts) {
    // File pattern: *.ts, *.{ts,tsx}
    if (part.startsWith("*.") || part.match(/^\*\.\{/)) {
      filePattern = part;
    }
    // Path prefix: src/, lib/
    else if (part.endsWith("/")) {
      pathPrefix = part;
    }
    // Search term
    else {
      searchTerms.push(part);
    }
  }

  return {
    filePattern,
    searchTerm: searchTerms.join(" "),
    pathPrefix,
  };
}

// ============================================================================
// Handler
// ============================================================================

async function handleGrep(
  ctx: ToolContext,
  params: GrepParams
): Promise<McpResult> {
  const query = params.query || params.pattern;

  if (!query) {
    return formatError("Missing query or pattern parameter");
  }

  // Parse query
  const parsed = parseGrepQuery(query);

  if (!parsed.searchTerm) {
    return formatError(
      "No search term found in query",
      "Example: mcx_grep({ query: '*.ts useState' })"
    );
  }

  // Get finder for search path
  const searchPath = params.path ? resolve(params.path) : ctx.basePath;

  try {
    const finder = await getFinderForPath(ctx, searchPath);

    // Build FFF query
    let fffQuery = parsed.searchTerm;
    if (parsed.filePattern) {
      fffQuery = `${parsed.filePattern} ${fffQuery}`;
    }
    if (parsed.pathPrefix) {
      fffQuery = `${parsed.pathPrefix} ${fffQuery}`;
    }

    // Execute search
    const results = finder.grep(fffQuery, {
        pageSize: 200,
        glob: parsed.filePattern || undefined,
      });

    if (!results.ok) {
      return formatError(`Search failed: ${results.error}`);
    }

    const items: GrepMatch[] = results.value.items.map(m => ({
        relativePath: m.relativePath,
        lineNumber: m.lineNumber,
        lineContent: m.lineContent,
      }));

    // Track usage
    trackToolUsage("mcx_grep");

    // Update proximity context with matched files
    const matchedFiles = [...new Set(items.map(i => i.relativePath))];
    updateProximityContext(matchedFiles.slice(0, 10), [parsed.searchTerm]);

    // No matches
    if (items.length === 0) {
      return formatToolResult(
        `No matches for "${parsed.searchTerm}" in ${results.value.totalFilesSearched} files.`,
        "\n→ Next: mcx_find (try different file pattern)"
      );
    }

    // Build proximity scores for sorting
    const proxScores = new Map<string, number>();
    for (const file of matchedFiles) {
      proxScores.set(file, getProximityScore(file));
    }

    // Format output
    const formatted = formatGrepMCX(
       items,
       results.value.totalMatched,
       results.value.totalFilesSearched,
      {
        pattern: parsed.searchTerm,
        proxScores,
      }
    );

    return formatToolResult(
      formatted.output,
      "\n→ Next: mcx_file (read full file context)"
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatError(`Grep failed: ${msg}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxGrep: ToolDefinition<GrepParams> = {
  name: "mcx_grep",
  description: `Search CONTENT inside files. NOT for finding files by name.

USE THIS FOR: "find useState in code", "search for TODO comments"
DO NOT USE FOR: "where is config.ts?" → use mcx_find instead

Query syntax:
- "TODO" - Search for text in all files
- "*.ts useState" - Search "useState" only in .ts files
- "src/ handleClick" - Search in src/ directory only
- "*.{ts,tsx} import" - Search in multiple file types`,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query with optional file pattern prefix",
      },
      pattern: {
        type: "string",
        description: "Alias for query (for compatibility)",
      },
      path: {
        type: "string",
        description: "Directory to search in (default: current project)",
      },
      context: {
        type: "number",
        description: "Lines of context to show around matches",
        default: 0,
      },
    },
  },
  handler: handleGrep,
  needsFinder: true,
};

export default mcxGrep;
