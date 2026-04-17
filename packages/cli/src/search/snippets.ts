import { SNIPPET_WINDOW, MAX_SNIPPETS, MIN_TERM_LENGTH, INTENT_SNIPPET_LENGTH, SNIPPET_MERGE_GAP, SNIPPET_MAX_MERGED } from "../tools/constants.js";
import type { SearchResult, SnippetWindow } from "./types.js";

/**
 * Extract a snippet around a search match.
 * FTS5 snippets come pre-centered with ** markers (stemming-aware).
 * Falls back to indexOf for content without markers.
 */
export function extractSnippet(
  content: string,
  query: string,
  windowSize = SNIPPET_WINDOW
): string {
  // FTS5 snippet already centered with ** markers - use directly
  if (content.includes('**')) {
    return content.replace(/\s+/g, ' ').trim();
  }

  // Fallback: center manually with indexOf
  const matchIndex = content.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex === -1) {
    return content.slice(0, windowSize * 2) + (content.length > windowSize * 2 ? '...' : '');
  }

  const start = Math.max(0, matchIndex - windowSize);
  const end = Math.min(content.length, matchIndex + query.length + windowSize);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet += '...';

  return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Highlight query terms in snippet.
 * Returns snippet with **bold** markers around matches.
 */
export function highlightSnippet(
  snippet: string,
  query: string
): string {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= MIN_TERM_LENGTH);
  let result = snippet;

  for (const term of terms) {
    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    result = result.replace(regex, '**$1**');
  }

  return result;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper: find all positions of a term in content
function findTermPositions(content: string, term: string): number[] {
  const lower = content.toLowerCase();
  const positions: number[] = [];
  let start = 0;

  while (start < content.length) {
    const idx = lower.indexOf(term, start);
    if (idx === -1) break;
    positions.push(idx);
    start = idx + term.length;
  }

  return positions;
}

// Merge close windows to preserve context between nearby matches
function mergeWindows(windows: SnippetWindow[]): SnippetWindow[] {
  if (windows.length === 0) return [];
  
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: SnippetWindow[] = [{ ...sorted[0] }];
  
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i];
    const last = merged[merged.length - 1];
    const gapTooLarge = w.start - last.end >= SNIPPET_MERGE_GAP;
    const wouldBeTooLong = w.end - last.start >= SNIPPET_MAX_MERGED;
    
    if (gapTooLarge || wouldBeTooLong) {
      merged.push({ ...w });
      continue;
    }
    
    last.end = w.end;
    last.matches += w.matches;
  }
  
  return merged;
}

// Helper: create snippet from range with ellipsis
function createSnippet(content: string, start: number, end: number): string {
  let snippet = content.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Extract multiple snippets for multi-word queries.
 * Merges nearby matches to preserve context.
 */
export function extractMultipleSnippets(
  content: string,
  query: string,
  maxSnippets = MAX_SNIPPETS,
  windowSize = SNIPPET_WINDOW
): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= MIN_TERM_LENGTH);
  if (terms.length === 0) return [];
  
  // 1. Collect all windows
  const windows: SnippetWindow[] = [];
  for (const term of terms) {
    for (const pos of findTermPositions(content, term)) {
      windows.push({
        start: Math.max(0, pos - windowSize),
        end: Math.min(content.length, pos + term.length + windowSize),
        matches: 1
      });
    }
  }
  
  // 2. Merge close windows
  const merged = mergeWindows(windows);
  
  // 3. Sort by match density (most relevant first)
  merged.sort((a, b) => (b.matches / (b.end - b.start)) - (a.matches / (a.end - a.start)));
  
  // 4. Extract snippets
  return merged.slice(0, maxSnippets).map(w => createSnippet(content, w.start, w.end));
}

/**
 * Format search results as snippets centered on intent.
 * Returns formatted string with bullet points.
 */
export function formatSearchSnippets(
  results: SearchResult[],
  intent: string
): string {
  if (results.length === 0) return '';

  const lines = [`Found ${results.length} matches for "${intent}":`];
  for (const r of results) {
    lines.push(`  • ${extractSnippet(r.snippet, intent, INTENT_SNIPPET_LENGTH)}`);
  }

  return lines.join("\n");
}