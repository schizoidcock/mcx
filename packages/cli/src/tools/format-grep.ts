/**
 * Grep Output Formatting
 * 
 * Formats grep/find results for display.
 * Extracted from serve.ts formatGrepMCX.
 */

import { compactPath, cleanLine } from "./utils.js";

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
  const {
    maxPerFile = GREP_MAX_PER_FILE,
    maxLineWidth = GREP_MAX_LINE_WIDTH,
    pattern,
    proxScores,
  } = options;

  // Group by file
  const byFile = new Map<string, GrepMatch[]>();
  for (const item of items) {
    const existing = byFile.get(item.relativePath) || [];
    existing.push(item);
    byFile.set(item.relativePath, existing);
  }

  // Sort files by proximity score if available
  const sortedFiles = proxScores
    ? [...byFile.entries()].sort((a, b) => 
        (proxScores.get(b[0]) || 0) - (proxScores.get(a[0]) || 0)
      )
    : [...byFile.entries()];

  // Limit files shown
  const filesToShow = sortedFiles.slice(0, GREP_MAX_FILES);
  const hiddenFiles = sortedFiles.length - filesToShow.length;

  // Format output
  const lines: string[] = [];
  let hiddenMatches = 0;

  for (const [filePath, matches] of filesToShow) {
    // Compact path
    const displayPath = compactPath(filePath, 60);
    lines.push(`\n${displayPath}`);

    // Show limited matches per file
    const toShow = matches.slice(0, maxPerFile);
    const hidden = matches.length - toShow.length;
    hiddenMatches += hidden;

    for (const match of toShow) {
      const lineNum = match.lineNumber.toString().padStart(4);
      const content = cleanLine(match.lineContent, maxLineWidth, pattern);
      lines.push(`  ${lineNum}: ${content}`);
    }

    if (hidden > 0) {
      lines.push(`  ... +${hidden} more matches`);
    }
  }

  // Summary line
  const summary: string[] = [];
  summary.push(`${totalMatched} matches in ${byFile.size} files`);
  if (hiddenFiles > 0) {
    summary.push(`(+${hiddenFiles} files hidden)`);
  }
  summary.push(`(searched ${totalFilesSearched} files)`);

  lines.unshift(summary.join(" "));

  return {
    output: lines.join("\n"),
    hiddenMatches,
    hiddenFiles,
  };
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
