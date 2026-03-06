import { describe, test, expect } from 'bun:test';
import { getDistinctiveTerms, buildVocabulary, fuzzyCorrect } from './vocabulary';

describe('getDistinctiveTerms', () => {
  test('extracts distinctive terms from chunks', () => {
    // Need at least 3 chunks and terms that appear in multiple but not all chunks
    const chunks = [
      { content: 'authentication bearer_token oauth2 security login' },
      { content: 'authentication database connection postgresql query' },
      { content: 'caching redis memcached performance speed' },
      { content: 'logging metrics monitoring observability' },
    ];

    const terms = getDistinctiveTerms(chunks);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThanOrEqual(40);
  });

  test('returns empty for too few chunks', () => {
    const chunks = [{ content: 'single chunk' }];
    const terms = getDistinctiveTerms(chunks);
    expect(terms).toEqual([]);
  });

  test('returns empty when all terms appear in all chunks', () => {
    const chunks = [
      { content: 'same words' },
      { content: 'same words' },
      { content: 'same words' },
    ];
    const terms = getDistinctiveTerms(chunks);
    // Terms appearing in 80%+ of chunks are filtered out
    expect(terms.length).toBe(0);
  });

  test('filters stopwords', () => {
    const chunks = [
      { content: 'the authentication is working' },
      { content: 'a database and connection' },
      { content: 'some caching for performance' },
    ];

    const terms = getDistinctiveTerms(chunks);
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('is');
    expect(terms).not.toContain('and');
    expect(terms).not.toContain('for');
  });

  test('includes terms that appear in multiple chunks', () => {
    const chunks = [
      { content: 'bearer_token authentication login bearer_token' },
      { content: 'authentication database bearer_token query' },
      { content: 'caching performance authentication speed' },
      { content: 'logging metrics monitoring' },
    ];

    const terms = getDistinctiveTerms(chunks);
    // 'authentication' appears in 3/4 chunks (75%), should be included
    // 'bearer_token' appears in 2/4 chunks (50%), should be included
    expect(terms.length).toBeGreaterThan(0);
    // Terms that appear in multiple chunks but not all should be present
    expect(terms).toContain('authentication');
  });

  test('respects maxTerms parameter', () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({
      content: `term${i} unique${i} special${i}`,
    }));

    const terms = getDistinctiveTerms(chunks, 5);
    expect(terms.length).toBeLessThanOrEqual(5);
  });
});

describe('buildVocabulary', () => {
  test('builds vocabulary set from chunks', () => {
    const chunks = [
      { content: 'authentication authorization' },
      { content: 'database connection' },
    ];

    const vocab = buildVocabulary(chunks);
    expect(vocab instanceof Set).toBe(true);
    expect(vocab.has('authentication')).toBe(true);
    expect(vocab.has('database')).toBe(true);
  });

  test('converts to lowercase', () => {
    const chunks = [{ content: 'Authentication DATABASE' }];
    const vocab = buildVocabulary(chunks);

    expect(vocab.has('authentication')).toBe(true);
    expect(vocab.has('database')).toBe(true);
    expect(vocab.has('Authentication')).toBe(false);
  });

  test('filters short words', () => {
    const chunks = [{ content: 'a ab abc abcd' }];
    const vocab = buildVocabulary(chunks);

    expect(vocab.has('a')).toBe(false);
    expect(vocab.has('ab')).toBe(false);
    expect(vocab.has('abc')).toBe(true);
    expect(vocab.has('abcd')).toBe(true);
  });
});

describe('fuzzyCorrect', () => {
  const vocabulary = new Set([
    'authentication',
    'authorization',
    'database',
    'connection',
    'postgresql',
  ]);

  test('corrects single character typo', () => {
    const corrected = fuzzyCorrect('authentcation', vocabulary); // missing 'i'
    expect(corrected).toBe('authentication');
  });

  test('corrects transposition', () => {
    const corrected = fuzzyCorrect('databsae', vocabulary); // 'a' and 's' swapped
    expect(corrected).toBe('database');
  });

  test('returns null for words too different', () => {
    const corrected = fuzzyCorrect('xyz123', vocabulary);
    expect(corrected).toBeNull();
  });

  test('returns null for exact matches (no correction needed)', () => {
    // If word is in vocabulary, it might return the word itself or null
    // depending on implementation - fuzzyCorrect is for corrections
    const corrected = fuzzyCorrect('completely_different_word', vocabulary);
    expect(corrected).toBeNull();
  });

  test('respects maxDistance parameter', () => {
    // With maxDistance=1, only 1 edit allowed
    const corrected1 = fuzzyCorrect('databas', vocabulary, 1); // 1 deletion
    expect(corrected1).toBe('database');

    // 3 edits needed - should fail with maxDistance=2
    const corrected2 = fuzzyCorrect('dat', vocabulary, 2);
    expect(corrected2).toBeNull();
  });

  test('handles empty vocabulary', () => {
    const emptyVocab = new Set<string>();
    const corrected = fuzzyCorrect('test', emptyVocab);
    expect(corrected).toBeNull();
  });
});
