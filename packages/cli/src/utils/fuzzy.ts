/**
 * Fuzzy matching utilities for parameter suggestions.
 * Linus-compliant: early returns, max 2 indent, O(n) space.
 */

/** Levenshtein distance - O(n) space optimization */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Normalize param name: lowercase, remove separators */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "");
}

/** Find similar params within maxDist edits */
export function findSimilarParams(name: string, validParams: string[], maxDist = 3): string[] {
  const normalized = normalize(name);
  
  return validParams
    .map(p => ({ param: p, dist: levenshtein(normalized, normalize(p)) }))
    .filter(x => x.dist > 0 && x.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 3)
    .map(x => x.param);
}
