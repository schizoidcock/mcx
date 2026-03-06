// Common stopwords to filter out
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
  'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'also', 'now', 'this', 'that', 'these', 'those', 'it', 'its', 'if', 'else',
  'true', 'false', 'null', 'undefined', 'return', 'function', 'const', 'let',
  'var', 'import', 'export', 'default', 'class', 'extends', 'new', 'typeof',
]);

// Patterns for code identifiers (higher value)
const SNAKE_CASE = /^[a-z]+(_[a-z]+)+$/;
const CAMEL_CASE = /^[a-z]+[A-Z][a-zA-Z]*$/;
const PASCAL_CASE = /^[A-Z][a-z]+[A-Z][a-zA-Z]*$/;

/**
 * Extract distinctive terms from content using IDF-like scoring.
 *
 * Terms that appear rarely are more distinctive.
 * Code identifiers (snake_case, camelCase) get bonus points.
 */
export function getDistinctiveTerms(
  chunks: Array<{ content: string }>,
  maxTerms = 40
): string[] {
  if (chunks.length < 3) return [];

  // Count term occurrences across chunks (document frequency)
  const termChunkCount = new Map<string, number>();
  const termTotalCount = new Map<string, number>();

  for (const chunk of chunks) {
    const terms = extractTerms(chunk.content);
    const seenInChunk = new Set<string>();

    for (const term of terms) {
      // Count total occurrences
      termTotalCount.set(term, (termTotalCount.get(term) || 0) + 1);

      // Count chunks containing term (for IDF)
      if (!seenInChunk.has(term)) {
        seenInChunk.add(term);
        termChunkCount.set(term, (termChunkCount.get(term) || 0) + 1);
      }
    }
  }

  // Calculate IDF-like score for each term
  const scored: Array<{ term: string; score: number }> = [];
  const numChunks = chunks.length;

  for (const [term, chunkCount] of termChunkCount.entries()) {
    // Skip terms that appear in too many chunks (not distinctive)
    if (chunkCount > numChunks * 0.8) continue;

    // Skip terms that appear only once (might be noise)
    const totalCount = termTotalCount.get(term) || 0;
    if (totalCount < 2) continue;

    // IDF score: log(N / df)
    let score = Math.log(numChunks / chunkCount);

    // Bonus for code identifiers
    if (SNAKE_CASE.test(term)) score *= 1.5;
    if (CAMEL_CASE.test(term)) score *= 1.5;
    if (PASCAL_CASE.test(term)) score *= 1.3;

    // Bonus for longer terms (more specific)
    if (term.length >= 8) score *= 1.2;

    scored.push({ term, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, maxTerms).map(s => s.term);
}

/**
 * Extract terms from text content.
 */
function extractTerms(text: string): string[] {
  // Split on non-word characters
  const words = text.split(/[^a-zA-Z0-9_]+/);

  return words
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Build vocabulary table from chunks for fuzzy correction.
 */
export function buildVocabulary(
  chunks: Array<{ content: string }>
): Set<string> {
  const vocab = new Set<string>();

  for (const chunk of chunks) {
    const terms = extractTerms(chunk.content);
    for (const term of terms) {
      vocab.add(term);
    }
  }

  return vocab;
}

/**
 * Find closest word in vocabulary using Levenshtein distance.
 * Returns null if no close match found.
 */
export function fuzzyCorrect(
  word: string,
  vocabulary: Set<string>,
  maxDistance = 2
): string | null {
  const lowerWord = word.toLowerCase();
  let bestMatch: string | null = null;
  let bestDistance = maxDistance + 1;

  for (const vocabWord of vocabulary) {
    // Skip words too different in length
    if (Math.abs(vocabWord.length - lowerWord.length) > maxDistance) continue;

    const distance = levenshteinDistance(lowerWord, vocabWord);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMatch = vocabWord;
    }
  }

  return bestDistance <= maxDistance ? bestMatch : null;
}

/**
 * Levenshtein edit distance with single-row optimization.
 * Space complexity O(min(n,m)) instead of O(n*m).
 */
function levenshteinDistance(a: string, b: string): number {
  // Ensure a is the shorter string for space efficiency
  if (a.length > b.length) [a, b] = [b, a];

  let prevRow = new Array(a.length + 1);
  let currRow = new Array(a.length + 1);

  // Initialize first row
  for (let i = 0; i <= a.length; i++) {
    prevRow[i] = i;
  }

  for (let j = 1; j <= b.length; j++) {
    currRow[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        prevRow[i] + 1,       // deletion
        currRow[i - 1] + 1,   // insertion
        prevRow[i - 1] + cost // substitution
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[a.length];
}
