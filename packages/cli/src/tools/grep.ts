/**
 * mcx_grep Tool
 *
 * Search CONTENT inside files.
 * NOT for finding files by name - use mcx_find instead.
 */

import { resolve, isAbsolute } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError } from "./utils.js";
import { setVariable } from "../context/variables.js";
import { formatGrepMCX, type GrepMatch } from "./format-grep.js";
import { trackToolUsage, updateProximityContext, getProximityScore } from "../context/tracking.js";
import { eventTips, errorTips } from "../context/tips.js";
import { validationErrors } from "../context/messages/index.js";
import { getFinderForPath } from "../context/create.js";
import { GREP_PAGE_SIZE } from "./constants.js";
import { debugGrep as debug } from "../utils/debug.js";

// ============================================================================
// Types
// ============================================================================

export interface GrepParams {
  query?: string;
  pattern?: string;  // Alias for query
  path?: string;     // Directory to search
  context?: number;  // Lines of context
  mode?: "plain" | "regex" | "fuzzy";  // Search mode (default: plain)
}

interface ValidatedGrep {
  parsed: ParsedQuery;
  path: string;
}

// ============================================================================
// Query Parsing
// ============================================================================

interface ParsedQuery {
  filePattern: string | null;  // e.g., "*.ts"
  searchTerm: string;          // The actual search term
  pathPrefix: string | null;   // e.g., "src/"
}

/** Detect if pattern uses regex syntax */
function needsRegexMode(pattern: string): boolean {
  return /[|()[\]{}^$+?\\]/.test(pattern);
}

/** Map fff grep results to GrepMatch[] */
function mapGrepItems(items: Array<{ 
  relativePath: string; 
  lineNumber: number; 
  lineContent: string; 
  contextBefore?: string[]; 
  contextAfter?: string[];
  totalFrecencyScore?: number;
  fuzzyScore?: number;
}>): GrepMatch[] {
  return items.map(m => ({
    relativePath: m.relativePath,
    lineNumber: m.lineNumber,
    lineContent: m.lineContent,
    contextBefore: m.contextBefore,
    contextAfter: m.contextAfter,
    frecencyScore: m.totalFrecencyScore ?? 0,
    fuzzyScore: m.fuzzyScore ?? 0,
  }));
}

/** Build fff query string */
function buildFffQuery(parsed: ParsedQuery): string {
  let query = parsed.searchTerm;
  if (parsed.filePattern) query = `${parsed.filePattern} ${query}`;
  if (parsed.pathPrefix) query = `${parsed.pathPrefix} ${query}`;
  return query;
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

/** Process grep results and return formatted output */
function processGrepResults(
  ctx: ToolContext,
  items: GrepMatch[],
  searchTerm: string,
  totalMatched: number,
  totalFiles: number,
  prefix: string = ""
): string {
  const matchedFiles = [...new Set(items.map(i => i.relativePath))];
  
  // Build proximity scores
  const proxScores = new Map<string, number>();
  for (const f of matchedFiles) proxScores.set(f, getProximityScore(f));
  
  // Store results
  setVariable("grep", { pattern: searchTerm, items, files: matchedFiles }, "search");
  
  // Format and index
  const formatted = formatGrepMCX(items, totalMatched, totalFiles, { pattern: searchTerm, proxScores });
  ctx.contentStore.index(formatted.output, `grep:${searchTerm}`, { contentType: "plaintext" });
  
  // Return confirmation
  const fileList = matchedFiles.slice(0, 5).join(", ");
  const more = matchedFiles.length > 5 ? ` +${matchedFiles.length - 5} more` : "";
  return `${prefix}✓ Found ${totalMatched} matches in ${matchedFiles.length} files\nFiles: ${fileList}${more}\nStored $grep`;
}

// ============================================================================
// Handler
// ============================================================================


function validateGrepParams(params: GrepParams): { ok: true; data: ValidatedGrep } | { ok: false; error: McpResult } {
  const query = params.query || params.pattern;
  
  if (!query) {
    return { ok: false, error: formatError(validationErrors.missing("query or pattern")) };
  }
  
  const parsed = parseGrepQuery(query);
  
  if (!parsed.searchTerm) {
    return { ok: false, error: formatError("No search term found", errorTips.noSearchTerm()) };
  }
  
  if (!params.path) {
    return { ok: false, error: formatError("Missing path parameter", errorTips.missingGrepPath(parsed.searchTerm)) };
  }
  
  if (!isAbsolute(params.path)) {
    return { ok: false, error: formatError(validationErrors.absolutePath(params.path)) };
  }

  // Detect file path (has extension) - grep needs directory
  if (params.path.match(/\.[a-zA-Z0-9]+$/)) {
    return { ok: false, error: formatError("Path must be a directory", errorTips.grepNeedsDirectory(params.path)) };
  }
  
  return { ok: true, data: { parsed, path: params.path } };
}

async function handleGrep(
  ctx: ToolContext,
  params: GrepParams
): Promise<McpResult> {
  const span = debug.span("handleGrep", { query: params.query || params.pattern, path: params.path, mode: params.mode });
  // Validate
  const v = validateGrepParams(params);
  if (!v.ok) { span.end({ error: "validation" }); return v.error; }
  const { parsed, path: basePath } = v.data;

  // Get finder for search path
  const searchPath = resolve(basePath);

  try {
    const finder = await getFinderForPath(ctx, searchPath);
    const fffQuery = buildFffQuery(parsed);
    const autoMode = params.mode || (needsRegexMode(parsed.searchTerm) ? "regex" : "plain");
    
    const contextLines = params.context ?? 3;
    const results = finder.grep(fffQuery, {
      pageSize: GREP_PAGE_SIZE,
      glob: parsed.filePattern || undefined,
      mode: autoMode,
      trimWhitespace: params.trimWhitespace ?? false,
      beforeContext: contextLines,
      afterContext: contextLines,
    });

    if (!results.ok) return formatError(`Search failed: ${results.error}`);

    const items = mapGrepItems(results.value.items);

    // Track usage
    trackToolUsage("mcx_grep");

    // Update proximity context with matched files
    const matchedFiles = [...new Set(items.map(i => i.relativePath))];
    updateProximityContext(matchedFiles.slice(0, 10), [parsed.searchTerm]);

    // No matches - retry with fuzzy if not already fuzzy
    if (items.length === 0 && autoMode !== "fuzzy" && !params.mode) {
      const fuzzy = finder.grep(fffQuery, { pageSize: GREP_PAGE_SIZE, glob: parsed.filePattern || undefined, mode: "fuzzy" });
      if (fuzzy.ok && fuzzy.value.items.length > 0) {
        return processGrepResults(ctx, mapGrepItems(fuzzy.value.items), parsed.searchTerm, 
          fuzzy.value.totalMatched, fuzzy.value.totalFilesSearched, "(fuzzy) ");
      }
      return eventTips.grepNoMatches(parsed.searchTerm, results.value.totalFilesSearched);
    }

    span.end({ matches: items.length, files: results.value.totalFilesSearched });
    return processGrepResults(ctx, items, parsed.searchTerm, 
      results.value.totalMatched, results.value.totalFilesSearched);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    span.end({ error: msg });
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
DO NOT USE FOR: "where is config.ts?" -> use mcx_find instead

Examples:
- mcx_grep({ query: "TODO", path: "/project" }) - Search all files
- mcx_grep({ query: "*.ts useState", path: "/project" }) - Only in .ts files
- mcx_grep({ query: "handleClick", mode: "regex", path: "/project" }) - Regex search
- mcx_grep({ query: "improt", mode: "fuzzy", path: "/project" }) - Typo-tolerant

Modes: plain (literal), regex (patterns with |), fuzzy (typo-tolerant)
Path is REQUIRED (absolute path to DIRECTORY, NOT a file)

View code blocks: Use context param, then mcx_search to see the code:
- mcx_grep({ query: "handleAuth", context: 3 }) -> finds and stores matches
- mcx_search({ queries: ["handleAuth"] }) -> shows function/block around match`,
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
        minimum: 0,
        maximum: 50,
        default: 3,
        description: "Lines of context",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 500,
        default: 50,
        description: "Max matches",
      },
      mode: {
        type: "string",
        enum: ["plain", "regex", "fuzzy"],
        default: "plain",
        description: "Search mode: plain (literal), regex (OR with |), fuzzy (typo-tolerant)",
      },
      trimWhitespace: {
        type: "boolean",
        default: false,
        description: "Trim leading/trailing whitespace from matched lines",
      },
    },
  },
  handler: handleGrep,
  needsFinder: true,
};

export default mcxGrep;
