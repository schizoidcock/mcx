/**
 * Grep Output Formatting
 * 
 * Formats grep/find results for display.
 * Extracted from serve.ts formatGrepMCX.
 */

import { compactPath } from "../utils/paths.js";
import { cleanLine } from "../utils/truncate.js";

// ============================================================================
// Types
// ============================================================================

export interface GrepMatch {
  relativePath: string;
  lineNumber: number;
  lineContent: string;
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

const GREP_MAX_PER_FILE = 5;
const GREP_MAX_LINE_WIDTH = 100;
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

/** Sort file entries by proximity score (higher first) */
function sortByProximity(
  entries: [string, GrepMatch[]][],
  proxScores: Map<string, number> | null
): [string, GrepMatch[]][] {
  if (!proxScores) return entries;
  return entries.sort((a, b) => (proxScores.get(b[0]) || 0) - (proxScores.get(a[0]) || 0));
}

/** Format matches for a single file */
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

  for (const m of toShow) {
    const lineNum = m.lineNumber.toString().padStart(4);
    lines.push(`  ${lineNum}: ${cleanLine(m.lineContent, maxLineWidth, pattern)}`);
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
// Formatting
// ============================================================================

/**
 * Format grep matches for display.
 * Groups by file, limits per-file matches, compacts paths.
 */
export function formatGrepMCX(
  items: GrepMatch[],
  totalMatched: number,
  totalFilesSearched: number,
  options: FormatGrepOptions = {}
): FormatGrepResult {
  const { maxPerFile = GREP_MAX_PER_FILE, maxLineWidth = GREP_MAX_LINE_WIDTH, pattern, proxScores } = options;

  const byFile = groupByFile(items);
  const sorted = sortByProximity([...byFile.entries()], proxScores);
  const filesToShow = sorted.slice(0, GREP_MAX_FILES);
  const hiddenFiles = sorted.length - filesToShow.length;

  const lines: string[] = [];
  let hiddenMatches = 0;

  for (const [path, matches] of filesToShow) {
    const result = formatFileMatches(path, matches, maxPerFile, maxLineWidth, pattern);
    lines.push(...result.lines);
    hiddenMatches += result.hidden;
  }

  lines.unshift(buildSummary(totalMatched, byFile.size, hiddenFiles, totalFilesSearched));

  return { output: lines.join("\n"), hiddenMatches, hiddenFiles };
}

/**
 * Format file find results for display.
 */
export function formatFindResults(
  files: Array<{ path: string; score?: number; status?: string }>,
  total: number,
  options: { maxFiles?: number; showScores?: boolean } = {}
): string {
  const { maxFiles = 20, showScores = false } = options;

  const toShow = files.slice(0, maxFiles);
  const hidden = total - toShow.length;

  const lines: string[] = [];
  lines.push(`Found ${total} files${hidden > 0 ? ` (showing ${maxFiles})` : ""}:`);
  lines.push("");

  for (const file of toShow) {
    let line = compactPath(file.path, 70);
    if (file.status) {
      line += ` [${file.status}]`;
    }
    if (showScores && file.score !== undefined) {
      line += ` (${file.score.toFixed(2)})`;
    }
    lines.push(line);
  }

  if (hidden > 0) {
    lines.push(`→ +${hidden} more files hidden`);
  }

  return lines.join("\n");
}

// ============================================================================
// Shell Grep Detection
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
        lineContent: match[4],
      });
    }
  }

  // Need ≥60% match and ≥3 results
  if (parsed.length / lines.length < 0.6 || parsed.length < 3) return null;

  const { output: formatted } = formatGrepMCX(
    parsed,
    parsed.length,
    new Set(parsed.map(p => p.relativePath)).size,
  );

  return formatted;
}