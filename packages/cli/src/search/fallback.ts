import type { SearchResult, SearchOptions } from './types.js';
import type { ContentStore } from './store.js';
import { fuzzyCorrect } from './vocabulary.js';

import { createDebugger } from "../utils/debug.js";
const debug = createDebugger("fallback");

/**
 * Reciprocal Rank Fusion (RRF) constant.
 * Higher k = more weight to lower-ranked results.
 * 60 is the standard value from the original RRF paper.
 */
const RRF_K = 60;

/**
 * RRF search: Run Porter AND Trigram in parallel, merge by rank fusion.
 * 
 * Unlike cascading fallback (Porter -> Trigram -> Fuzzy), RRF runs both
 * strategies and merges results so documents that rank well in BOTH
 * strategies surface higher than those ranking well in only one.
 * 
 * Falls back to fuzzy correction only if RRF returns nothing.
 */
export function searchWithFallback(
  store: ContentStore,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const limit = options.limit ?? 10;
  
  // Run Porter and Trigram in parallel (both always run)
  const porterResults = store.search(query, { ...options, limit: limit * 2 });
  const trigramResults = store.searchTrigram(query, { ...options, limit: limit * 2 });
  
  // Merge with RRF
  const merged = reciprocalRankFusion(porterResults, trigramResults);
  
  if (merged.length > 0) {
    // Apply proximity reranking for multi-term queries
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const reranked = terms.length > 1 
      ? proximityRerank(merged, terms)
      : merged;
    
    return reranked.slice(0, limit);
  }
  
  // Fallback: Fuzzy correction (typo fix)
  const vocabulary = store.getVocabulary();
  const words = query.split(/\s+/).filter(w => w.length >= 3);

  const correctedWords = words.map(word => {
    const correction = fuzzyCorrect(word, vocabulary);
    return correction ?? word;
  });

  const correctedQuery = correctedWords.join(' ');

  if (correctedQuery !== query) {
    // Recursively search with corrected query (will use RRF)
    const fuzzyResults = searchWithFallback(store, correctedQuery, options);
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
 * Reciprocal Rank Fusion - merge two ranked result lists.
 * 
 * RRF score = Σ 1/(k + rank) for each list where the document appears.
 * Documents appearing in both lists get higher combined scores.
 */
function reciprocalRankFusion(
  listA: SearchResult[],
  listB: SearchResult[]
): SearchResult[] {
  const scores = new Map<string, { score: number; result: SearchResult }>();
  
  // Score from list A (Porter)
  listA.forEach((result, rank) => {
    const key = `${result.sourceId}:${result.title}`;
    const rrfScore = 1 / (RRF_K + rank);
    scores.set(key, { score: rrfScore, result });
  });
  
  // Add scores from list B (Trigram)
  listB.forEach((result, rank) => {
    const key = `${result.sourceId}:${result.title}`;
    const rrfScore = 1 / (RRF_K + rank);
    const existing = scores.get(key);
    
    if (existing) {
      // Document in both lists - add scores
      existing.score += rrfScore;
    } else {
      scores.set(key, { score: rrfScore, result });
    }
  });
  
  // Sort by combined RRF score (descending)
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(item => item.result);
}

/**
 * Proximity Reranking - boost results where query terms appear close together.
 * 
 * For multi-term queries like "session continuity", results where the terms
 * appear adjacent or nearby are boosted over results where terms appear
 * far apart in the document.
 */
function proximityRerank(
  results: SearchResult[],
  terms: string[]
): SearchResult[] {
  if (terms.length < 2) return results;
  
  return results
    .map(result => {
      const content = (result.snippet || result.content || '').toLowerCase();
      const boost = calculateProximityBoost(content, terms);
      return { ...result, _proximityBoost: boost };
    })
    .sort((a, b) => {
      // Sort by proximity boost first, then by original order
      const boostDiff = (b._proximityBoost || 0) - (a._proximityBoost || 0);
      return boostDiff;
    })
    .map(({ _proximityBoost, ...result }) => result);
}

/**
 * Calculate proximity boost based on minimum distance between terms.
 * 
 * Returns a score 0-1 where:
 * - 1.0 = terms are adjacent
 * - 0.5 = terms within 50 chars
 * - 0.0 = terms very far apart or not all present
 */
function calculateProximityBoost(content: string, terms: string[]): number {
  // Find positions of all terms
  const positions: number[][] = terms.map(term => {
    const pos: number[] = [];
    let idx = content.indexOf(term);
    while (idx !== -1) {
      pos.push(idx);
      idx = content.indexOf(term, idx + 1);
    }
    return pos;
  });
  
  // If any term is missing, no boost
  if (positions.some(p => p.length === 0)) {
    return 0;
  }
  
  // Find minimum span that contains all terms
  let minSpan = Infinity;
  
  // Simple approach: for each position of first term, find closest positions of other terms
  for (const firstPos of positions[0]) {
    let maxDist = 0;
    for (let i = 1; i < positions.length; i++) {
      // Find closest position of term i to firstPos
      const closest = positions[i].reduce((best, pos) => {
        const dist = Math.abs(pos - firstPos);
        return dist < best ? dist : best;
      }, Infinity);
      maxDist = Math.max(maxDist, closest);
    }
    minSpan = Math.min(minSpan, maxDist);
  }
  
  // Convert span to boost (0-1)
  // Adjacent terms (span ~10) = 1.0
  // Within 50 chars = 0.5
  // Within 200 chars = 0.25
  // Beyond = 0
  if (minSpan <= 10) return 1.0;
  if (minSpan <= 50) return 0.5;
  if (minSpan <= 200) return 0.25;
  return 0;
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
