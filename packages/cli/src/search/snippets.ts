const DEFAULT_WINDOW = 300;

/**
 * Extract a snippet around a search match.
 * Returns ±300 chars around the match position.
 */
export function extractSnippet(
  content: string,
  query: string,
  windowSize = DEFAULT_WINDOW
): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Find match position
  const matchIndex = lowerContent.indexOf(lowerQuery);
  if (matchIndex === -1) {
    // No exact match, return start of content
    return content.slice(0, windowSize * 2) + (content.length > windowSize * 2 ? '...' : '');
  }

  // Calculate window bounds
  const start = Math.max(0, matchIndex - windowSize);
  const end = Math.min(content.length, matchIndex + query.length + windowSize);

  // Extract and clean up
  let snippet = content.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  // Clean up whitespace
  snippet = snippet.replace(/\s+/g, ' ').trim();

  return snippet;
}

/**
 * Highlight query terms in snippet.
 * Returns snippet with **bold** markers around matches.
 */
export function highlightSnippet(
  snippet: string,
  query: string
): string {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
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

/**
 * Extract multiple snippets for multi-word queries.
 * Returns one snippet per significant match location.
 */
export function extractMultipleSnippets(
  content: string,
  query: string,
  maxSnippets = 3,
  windowSize = DEFAULT_WINDOW
): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  const lowerContent = content.toLowerCase();
  const snippets: string[] = [];
  const usedRanges: Array<{ start: number; end: number }> = [];

  for (const term of terms) {
    if (snippets.length >= maxSnippets) break;

    let searchStart = 0;
    while (searchStart < content.length && snippets.length < maxSnippets) {
      const matchIndex = lowerContent.indexOf(term, searchStart);
      if (matchIndex === -1) break;

      // Check if this range overlaps with existing snippets
      const snippetStart = Math.max(0, matchIndex - windowSize);
      const snippetEnd = Math.min(content.length, matchIndex + term.length + windowSize);

      const overlaps = usedRanges.some(
        range => !(snippetEnd < range.start || snippetStart > range.end)
      );

      if (!overlaps) {
        let snippet = content.slice(snippetStart, snippetEnd);
        if (snippetStart > 0) snippet = '...' + snippet;
        if (snippetEnd < content.length) snippet = snippet + '...';
        snippet = snippet.replace(/\s+/g, ' ').trim();

        snippets.push(snippet);
        usedRanges.push({ start: snippetStart, end: snippetEnd });
      }

      searchStart = matchIndex + term.length;
    }
  }

  return snippets;
}
