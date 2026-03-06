import type { SearchResult, SearchOptions } from './types.js';
import type { ContentStore } from './store.js';
import { fuzzyCorrect } from './vocabulary.js';

/**
 * Three-layer search fallback.
 *
 * Layer 1: Porter stemming (running -> run)
 * Layer 2: Trigram (auth -> authentication)
 * Layer 3: Fuzzy Levenshtein (authetication -> authentication)
 */
export function searchWithFallback(
  store: ContentStore,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  // Layer 1: Porter stemming
  const porterResults = store.search(query, options);
  if (porterResults.length > 0) {
    return porterResults;
  }

  // Layer 2: Trigram substring matching
  const trigramResults = store.searchTrigram(query, options);
  if (trigramResults.length > 0) {
    return trigramResults;
  }

  // Layer 3: Fuzzy correction
  const vocabulary = store.getVocabulary();
  const words = query.split(/\s+/).filter(w => w.length >= 3);

  const correctedWords = words.map(word => {
    const correction = fuzzyCorrect(word, vocabulary);
    return correction ?? word;
  });

  const correctedQuery = correctedWords.join(' ');

  // Only search if we actually corrected something
  if (correctedQuery !== query) {
    const fuzzyResults = store.search(correctedQuery, options);
    if (fuzzyResults.length > 0) {
      return fuzzyResults.map(r => ({
        ...r,
        matchType: 'fuzzy' as const,
      }));
    }
  }

  return [];
}

/**
 * Search with scoped fallback to specific source first.
 * If no results, broadens to all sources.
 */
export function searchWithScope(
  store: ContentStore,
  query: string,
  sourceId: number,
  options: SearchOptions = {}
): SearchResult[] {
  // Try scoped search first
  const scopedResults = searchWithFallback(store, query, {
    ...options,
    sourceId,
  });

  if (scopedResults.length > 0) {
    return scopedResults;
  }

  // Broaden to all sources
  return searchWithFallback(store, query, options);
}

/**
 * Batch search multiple queries, returning results grouped by query.
 */
export function batchSearch(
  store: ContentStore,
  queries: string[],
  options: SearchOptions = {}
): Record<string, SearchResult[]> {
  const results: Record<string, SearchResult[]> = {};
  const limit = options.limit ?? 5;

  for (const query of queries) {
    results[query] = searchWithFallback(store, query, {
      ...options,
      limit,
    });
  }

  return results;
}
