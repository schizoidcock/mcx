/**
 * mcx_find Tool
 *
 * Find FILES by name. NOT for searching content inside files.
 * Use mcx_grep for content search.
 */

import { resolve, isAbsolute, dirname, basename, relative } from "node:path";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError } from "./utils.js";

import { compactPath, normalizePath } from "../utils/paths.js";
import { trackToolUsage, updateProximityContext, getProximityScore } from "../context/tracking.js";
import { initializeFinder, getFinderForPath } from "../context/create.js";
import {
  IMPORT_REGEX,
  RESOLVE_EXTENSIONS,
  SOURCE_GLOB,
  SOURCE_EXT_REGEX,
  RELATED_PAGE_SIZE,
  normalizeScore,
} from "./constants.js";

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

interface ImporterMatch {
  path: string;
  line: number;
  snippet: string;
}

interface ValidatedFind {
  query: string;
  path: string;
  limit: number;
}
// ============================================================================
// Handler
// ============================================================================


function validateFindParams(params: FindParams): { ok: true; data: ValidatedFind } | { ok: false; error: McpResult } {
  const query = params.query || params.pattern;
  
  if (!query) {
    return { ok: false, error: formatError(
      "Missing query or pattern parameter",
      "Example: mcx_find({ query: '*.ts' }) or mcx_find({ related: 'file.ts' })"
    )};
  }
  
  if (!params.path) {
    return { ok: false, error: formatError(
      "path parameter is required",
      'mcx_find({ query: "*.ts", path: "/abs/path/to/project" })'
    )};
  }
  
  if (!isAbsolute(params.path)) {
    return { ok: false, error: formatError(`Absolute path required. Got: "${params.path}"`) };
  }
  
  return { ok: true, data: { query, path: params.path, limit: params.limit || 20 } };
}

/** Parse query for embedded path (Linus: single responsibility) */
function parseQueryPath(
  query: string,
  basePath: string
): { searchPath: string; searchQuery: string } | McpResult {
  const lastSlash = query.lastIndexOf("/");
  if (lastSlash <= 0) return { searchPath: resolve(basePath), searchQuery: query };
  
  const pathPart = query.slice(0, lastSlash);
  if (!isAbsolute(pathPart) && !pathPart.includes("*") && !pathPart.includes("?")) {
    return formatError(
      `Absolute path required. Got: "${pathPart}"`,
      `Use full path: mcx_find({ query: "/absolute/path/${query}" })`
    );
  }
  return { searchPath: resolve(basePath, pathPart), searchQuery: query.slice(lastSlash + 1) };
}

/** Score and sort files by combined fff+proximity (Linus: single responsibility) */
function scoreAndSortFiles<T extends { relativePath: string }>(
  files: T[],
  fffScores: Array<{ total?: number }> | undefined
): T[] {
  const scored = files.map((f, i) => {
    const fff = normalizeScore(fffScores?.[i]?.total || 0, 100);
    const prox = normalizeScore(getProximityScore(f.relativePath), 10);
    return { file: f, score: (fff * 0.7) + (prox * 0.3) };
  });
  return scored.sort((a, b) => b.score - a.score).map(s => s.file);
}

/** Format find results (Linus: extract formatting) */
function formatFindResults(
  files: Array<{ relativePath: string; status?: string }>,
  fffScores: Array<{ total?: number }> | undefined,
  limit: number
): string {
  const sorted = scoreAndSortFiles(files, fffScores);
  const toShow = sorted.slice(0, limit);
  const hidden = files.length - toShow.length;

  const lines = [`Found ${files.length} files${hidden > 0 ? ` (showing ${limit}, +${hidden} hidden)` : ""}:`, ""];
  for (const file of toShow) {
    let line = file.relativePath;
    if (file.status === "modified") line += " ★";
    else if (file.status === "untracked") line += " [untracked]";
    lines.push(line);
  }
  return lines.join("\n");
}

async function handleFind(
  ctx: ToolContext,
  params: FindParams
): Promise<McpResult> {
  // Related files mode (different flow)
  if (params.related) return handleFindRelated(ctx, params.related);

  // Validate
  const v = validateFindParams(params);
  if (!v.ok) return v.error;
  const { query, path: basePath, limit } = v.data;

  // Parse query for embedded path
  const parsed = parseQueryPath(query, basePath);
  if ('content' in parsed) return parsed; // Error result
  const { searchPath, searchQuery } = parsed;

  try {
    const finder = await getFinderForPath(ctx, searchPath);

    // Execute search based on type
    const searchType = params.type || "files";
    const results = searchType === "dirs"
      ? finder.directorySearch(searchQuery, { pageSize: limit * 2 })
      : searchType === "all"
        ? finder.mixedSearch(searchQuery, { pageSize: limit * 2 })
        : finder.fileSearch(searchQuery, { pageSize: limit * 2 });

    if (!results.ok) {
      return formatError(`Search failed: ${results.error}`);
    }

    const files = results.value.items;
    const fffScores = results.value.scores || [];

    // Track usage
    trackToolUsage("mcx_find");

    // Update proximity context
    updateProximityContext(
      files.slice(0, 5).map(f => f.relativePath),
      [query]
    );

    // No matches
    if (files.length === 0) {
      const typeLabel = searchType === "dirs" ? "directories" : searchType === "all" ? "files/dirs" : "files";
      return `No ${typeLabel} matching "${query}" (searched: ${results.value.totalMatched || 0})\n-> Try: broader pattern or different path`;
    }

    return formatFindResults(files, fffScores, limit);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return formatError(`Find failed: ${msg}`);
  }
}

// ============================================================================
// Related Files - Helpers
// ============================================================================

/** Walk up from startDir until package.json found */
async function findProjectRoot(startDir: string): Promise<string> {
  let current = startDir;
  while (current !== dirname(current)) {
    if (await Bun.file(resolve(current, "package.json")).exists()) return current;
    current = dirname(current);
  }
  return startDir;
}

/** Extract import paths from file content */
function extractImports(content: string): string[] {
  IMPORT_REGEX.lastIndex = 0;
  const imports: string[] = [];
  let match;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    const path = match[1] || match[2];
    if (path && !path.startsWith("node_modules")) imports.push(path);
  }
  return imports;
}

/** Find line number and snippet where target is imported */
function findImportLine(content: string, targetBase: string): { line: number; snippet: string } | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(targetBase)) continue;
    if (!IMPORT_REGEX.test(line)) continue;
    IMPORT_REGEX.lastIndex = 0;
    return { line: i + 1, snippet: line.trim() };
  }
  return null;
}
/** Resolve import path to absolute file path */
async function resolveImport(fromFile: string, importPath: string): Promise<string | null> {
  if (!importPath.startsWith(".")) return null;
  const cleanPath = importPath.replace(/\.js$/, "");
  const base = resolve(dirname(fromFile), cleanPath);
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = base + ext;
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

/** Format output section */
function formatSection(title: string, items: string[], prefix: string, max: number): string[] {
  if (items.length === 0) return [];
  const lines = [`${title} (${items.length}):`];
  for (const item of items.slice(0, max)) lines.push(`  ${prefix} ${item}`);
  if (items.length > max) lines.push(`  ... +${items.length - max} more`);
  lines.push("");
  return lines;
}

/** Format importers with line context */
function formatImporters(importers: ImporterMatch[], max: number): string[] {
  if (importers.length === 0) return [];
  const lines = [`Imported by (${importers.length}):`];
  for (const m of importers.slice(0, max)) {
    lines.push(`  ← ${m.path}:${m.line} -> ${m.snippet.slice(0, 60)}${m.snippet.length > 60 ? '...' : ''}`);
  }
  if (importers.length > max) lines.push(`  ... +${importers.length - max} more`);
  lines.push("");
  return lines;
}
/** Get files that import target with context */
async function getImporters(
  finder: Awaited<ReturnType<typeof getFinderForPath>>,
  basePath: string,
  target: string,
  targetRel: string
): Promise<ImporterMatch[]> {
  const targetBase = basename(target).replace(SOURCE_EXT_REGEX, "");
  const grepResult = finder.grep(`${targetBase}.`, { glob: SOURCE_GLOB, pageSize: RELATED_PAGE_SIZE });
  if (!grepResult.ok) return [];

  const seen = new Set<string>();
  const importers: ImporterMatch[] = [];
  
  for (const item of grepResult.value.items) {
    const fullPath = resolve(basePath, item.path);
    const relPath = normalizePath(relative(basePath, fullPath));
    if (relPath === targetRel || seen.has(relPath)) continue;
    
    const content = await Bun.file(fullPath).text().catch(() => "");
    const match = findImportLine(content, targetBase);
    if (!match) continue;
    
    seen.add(relPath);
    importers.push({ path: relPath, line: match.line, snippet: match.snippet });
  }
  
  return importers;
}

/** Get sibling files in same directory */
async function getSiblings(targetDir: string, target: string, basePath: string): Promise<string[]> {
  const targetNorm = normalizePath(target).toLowerCase();
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(targetDir).catch(() => [] as string[]);
  
  return entries
    .filter(e => SOURCE_EXT_REGEX.test(e))
    .map(e => resolve(targetDir, e))
    .filter(p => normalizePath(p).toLowerCase() !== targetNorm)
    .map(p => normalizePath(relative(basePath, p)));
}

// ============================================================================
// Related Files - Handler
// ============================================================================

async function handleFindRelated(ctx: ToolContext, targetFile: string): Promise<McpResult> {
  const target = isAbsolute(targetFile) ? targetFile : resolve(process.cwd(), targetFile);
  if (!await Bun.file(target).exists()) return formatError(`File not found: ${targetFile}`);

  const targetDir = dirname(target);
  const basePath = await findProjectRoot(targetDir);
  const finder = await getFinderForPath(ctx, basePath);
  const targetRel = normalizePath(relative(basePath, target));

  // Get imports
  const content = await Bun.file(target).text();
  const resolved = await Promise.all(extractImports(content).map(p => resolveImport(target, p)));
  const imports = resolved.filter(Boolean).map(p => normalizePath(relative(basePath, p!)));

  // Get importers and siblings
  const importers = await getImporters(finder, basePath, target, targetRel);
  const siblings = await getSiblings(targetDir, target, basePath);

  trackToolUsage("mcx_find", targetFile);

  // Format output
  const lines = [`Related files for: ${targetRel}`, ""];
  lines.push(...formatSection("Imports", imports, "->", 10));
  lines.push(...formatImporters(importers, 10));
  lines.push(...formatSection("Siblings", siblings, "-", 5));

  if (imports.length === 0 && importers.length === 0 && siblings.length === 0) {
    lines.push("No related files found.");
  }

  return lines.join("\n");
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxFind: ToolDefinition<FindParams> = {
  name: "mcx_find",
  description: `Find files or directories by name. NOT for searching content inside files.

USE THIS FOR: "where is config.ts?", "find all *.test.ts", "find src directories"
DO NOT USE FOR: "find useState in code" -> use mcx_grep instead

Examples:
- mcx_find({ query: "*.ts", path: "/project" }) - Find TypeScript files
- mcx_find({ query: "src", type: "dirs", path: "/project" }) - Find directories
- mcx_find({ query: "config", type: "all", path: "/project" }) - Files and dirs
- mcx_find({ related: "serve.ts", path: "/project" }) - Find imports/importers

Query syntax: "file.ts", "*.ts", "!test", "status:modified"
Path is REQUIRED (absolute path to project directory)`,
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
        minimum: 1,
        maximum: 200,
        default: 20, description: "Maximum results",
      },
      type: {
        type: "string",
        enum: ["files", "dirs", "all"],
        default: "files",
        description: "Search type: files, dirs, or all",
      },
    },
  },
  handler: handleFind,
  needsFinder: true,
};

export default mcxFind;
