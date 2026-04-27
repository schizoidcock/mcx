/**
 * Grep Output Formatting
 * 
 * Formats grep/find results for display.
 * Extracted from serve.ts formatGrepMCX.
 */

import { compactPath } from "../utils/paths.js";
import { cleanLine } from "../utils/truncate.js";
import { normalizeScore } from "./constants.js";

// ============================================================================
// Types
// ============================================================================

export interface GrepMatch {
  relativePath: string;
  lineNumber: number;
  lineContent: string;
  contextBefore?: string[];
  contextAfter?: string[];
  frecencyScore?: number;
  fuzzyScore?: number;
}

export interface FormatGrepOptions {
  maxPerFile?: number;
  maxLineWidth?: number;
  pattern?: string;
  proxScores?: Map<string, number> | null;
}

export interface FormatGrepResult {
  output: string;
  hiddenMatches: number;
  hiddenFiles: number;
}

// ============================================================================
// Constants
// ============================================================================

import { GREP_MAX_PER_FILE, GREP_MAX_LINE_WIDTH } from "./constants.js";

import { createDebugger } from "../utils/debug.js";
const debug = createDebugger("formatgrep");

const GREP_MAX_FILES = 20;

// ============================================================================
// Helpers (Linus: funciones pequeñas que hacen UNA cosa)
// ============================================================================

/** Group matches by file path */
function groupByFile(items: GrepMatch[]): Map<string, GrepMatch[]> {
  const byFile = new Map<string, GrepMatch[]>();
  for (const item of items) {
    const existing = byFile.get(item.relativePath) || [];
    existing.push(item);
    byFile.set(item.relativePath, existing);
  }
  return byFile;
}

/** Calculate combined score for a file's matches */
function calculateFileScore(
  matches: GrepMatch[],
  proximityScore: number
): number {
  if (matches.length === 0) return proximityScore;
  
  // Average frecency and fuzzy scores across matches
  const avgFrecency = matches.reduce((sum, m) => sum + (m.frecencyScore || 0), 0) / matches.length;
  const avgFuzzy = matches.reduce((sum, m) => sum + (m.fuzzyScore || 0), 0) / matches.length;
  
  // Normalize scores (fuzzy is 0-100, frecency varies widely)
  const normalizedFrecency = normalizeScore(avgFrecency, 1000);
  const normalizedFuzzy = avgFuzzy;
  const normalizedProximity = normalizeScore(proximityScore, 10);
  
  // Weighted combination: fuzzy (40%), frecency (30%), proximity (30%)
  return (normalizedFuzzy * 0.4) + (normalizedFrecency * 0.3) + (normalizedProximity * 0.3);
}

/** Sort file entries by combined score (fuzzy + frecency + proximity) */
function sortByProximity(
  entries: [string, GrepMatch[]][],
  proxScores: Map<string, number> | null
): [string, GrepMatch[]][] {
  return entries.sort((a, b) => {
    const scoreA = calculateFileScore(a[1], proxScores?.get(a[0]) || 0);
    const scoreB = calculateFileScore(b[1], proxScores?.get(b[0]) || 0);
    return scoreB - scoreA;
  });
}

/** Format context lines (Linus: eliminates duplication) */
function formatContextLines(ctx: string[], start: number, maxW: number): string[] {
  return ctx.map((line, i) => `  ${(start + i).toString().padStart(4)}  ${cleanLine(line, maxW)}`);
}

/** Format matches for a single file (Linus: max 3 indent) */
function formatFileMatches(
  filePath: string,
  matches: GrepMatch[],
  maxPerFile: number,
  maxLineWidth: number,
  pattern?: string
): { lines: string[]; hidden: number } {
  const lines = [`\n${compactPath(filePath, 60)}`];
  const toShow = matches.slice(0, maxPerFile);
  const hidden = matches.length - toShow.length;

  for (const [i, m] of toShow.entries()) {
    const hasContext = (m.contextBefore?.length || 0) + (m.contextAfter?.length || 0) > 0;
    
    if (m.contextBefore?.length) {
      lines.push(...formatContextLines(m.contextBefore, m.lineNumber - m.contextBefore.length, maxLineWidth));
    }
    
    lines.push(`  ${m.lineNumber.toString().padStart(4)}> ${cleanLine(m.lineContent, maxLineWidth, pattern)}`);
    
    if (m.contextAfter?.length) {
      lines.push(...formatContextLines(m.contextAfter, m.lineNumber + 1, maxLineWidth));
    }
    
    if (hasContext && i < toShow.length - 1) lines.push(`  ----`);
  }
  if (hidden > 0) lines.push(`  ... +${hidden} more matches`);

  return { lines, hidden };
}

/** Build summary line */
function buildSummary(totalMatched: number, fileCount: number, hiddenFiles: number, searched: number): string {
  const parts = [`${totalMatched} matches in ${fileCount} files`];
  if (hiddenFiles > 0) parts.push(`(+${hiddenFiles} files hidden)`);
  parts.push(`(searched ${searched} files)`);
  return parts.join(" ");
}

// ============================================================================
// Main Formatter
// ============================================================================

/**
 * Format grep results for display
 * Groups by file, sorts by proximity, limits output
 */
export function formatGrepMCX(
  items: GrepMatch[],
  totalMatched: number,
  totalFiles: number,
  options: FormatGrepOptions = {}
): FormatGrepResult {
  const {
    maxPerFile = GREP_MAX_PER_FILE,
    maxLineWidth = GREP_MAX_LINE_WIDTH,
    pattern,
    proxScores = null
  } = options;

  // Group by file
  const byFile = groupByFile(items);
  
  // Sort entries by proximity score
  const sortedEntries = sortByProximity([...byFile.entries()], proxScores);

  // Limit files shown
  const toShow = sortedEntries.slice(0, GREP_MAX_FILES);
  const hiddenFiles = sortedEntries.length - toShow.length;

  // Format each file's matches
  const outputLines: string[] = [];
  let totalHiddenMatches = 0;

  for (const [filePath, matches] of toShow) {
    const { lines, hidden } = formatFileMatches(filePath, matches, maxPerFile, maxLineWidth, pattern);
    outputLines.push(...lines);
    totalHiddenMatches += hidden;
  }

  // Build final output
  const summary = buildSummary(totalMatched, totalFiles, hiddenFiles, totalFiles);
  const output = summary + outputLines.join("\n");

  return {
    output,
    hiddenMatches: totalHiddenMatches,
    hiddenFiles
  };
}

// ============================================================================
// Find Formatter (reuses grep infrastructure)
// ============================================================================

export interface FindMatch {
  relativePath: string;
  isDir?: boolean;
  status?: string;
}

export function formatFindMCX(
  items: FindMatch[],
  totalMatched: number,
  options: { limit?: number; proxScores?: Map<string, number> | null } = {}
): string {
  const { limit = 20, proxScores = null } = options;

  if (items.length === 0) {
    return `No files found (searched ${totalMatched} files)`;
  }

  // Sort by proximity if available
  const sorted = proxScores
    ? items.sort((a, b) => (proxScores.get(b.relativePath) || 0) - (proxScores.get(a.relativePath) || 0))
    : items;

  const toShow = sorted.slice(0, limit);
  const hidden = items.length - toShow.length;

  const lines = toShow.map(f => {
    const icon = f.isDir ? "📁" : "📄";
    const status = f.status ? ` [${f.status}]` : "";
    return `${icon} ${f.relativePath}${status}`;
  });

  const header = `Found ${items.length} files${hidden > 0 ? ` (showing ${limit})` : ""}:`;
  return [header, ...lines, hidden > 0 ? `... +${hidden} more` : ""].filter(Boolean).join("\n");
}

// ============================================================================
// Auto-detect Grep Output
// ============================================================================

/** Pattern: file:linenum:content (handles Windows paths like D:/path) */
const GREP_LINE_PATTERN = /^(.+):(\d+)([:=-])(.*)$/;

/**
 * Detect if output looks like grep/rg output and format it.
 * Returns formatted output if ≥60% lines match, null otherwise.
 */
export function detectAndFormatGrepOutput(output: string): string | null {
  const lines = output.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.length < 2) return null;

  const parsed: GrepMatch[] = [];
  for (const line of lines) {
    const match = line.match(GREP_LINE_PATTERN);
    if (match) {
      parsed.push({
        relativePath: match[1],
        lineNumber: parseInt(match[2], 10),
        lineContent: match[4] || "",
      });
    }
  }

  if (parsed.length / lines.length < 0.6) return null;

  const totalMatched = parsed.length;
  const files = new Set(parsed.map(p => p.relativePath)).size;
  return formatGrepMCX(parsed, totalMatched, files).output;
}
