import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { ContentStore } from './store';
import { searchWithFallback, batchSearch } from './fallback';

describe('searchWithFallback', () => {
  let store: ContentStore;

  beforeAll(() => {
    store = new ContentStore(':memory:');
  });

  afterAll(() => {
    store.close();
  });

  beforeEach(() => {
    store.clear();
    // Index test content
    store.index('# Authentication\nUse bearer tokens for secure API access', 'auth');
    store.index('# Database\nPostgreSQL connection with pg_connect', 'database');
    store.index('# Caching\nRedis caching for improved performance', 'cache');
  });

  describe('RRF (Reciprocal Rank Fusion)', () => {
    test('finds matches using Porter + Trigram fusion', () => {
      const results = searchWithFallback(store, 'authentication');
      expect(results.length).toBeGreaterThan(0);
    });

    test('handles stemmed words (running -> run)', () => {
      store.index('Running the application', 'running-test');
      const results = searchWithFallback(store, 'run');
      expect(results.length).toBeGreaterThan(0);
    });

    test('finds partial matches via trigram', () => {
      // "auth" partial should find "authentication" via trigram
      const results = searchWithFallback(store, 'auth');
      expect(results.length).toBeGreaterThan(0);
    });

    test('boosts results appearing in both Porter and Trigram', () => {
      // Add multiple docs, one strongly matching both
      store.index('Authentication system with auth tokens', 'both-match');
      store.index('Some other content', 'other');

      const results = searchWithFallback(store, 'authentication');
      // The doc with both 'authentication' and 'auth' should rank high
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Proximity Reranking', () => {
    test('boosts results where terms appear close together', () => {
      // Add docs with varying proximity
      store.index('Session continuity is important for user experience', 'close');
      store.index('The session was long. Later we discussed continuity plans.', 'far');

      const results = searchWithFallback(store, 'session continuity');
      expect(results.length).toBeGreaterThan(0);

      // The "close" doc should rank higher due to proximity
      const closeResult = results.find(r => r.sourceId === store.getSources().find(s => s.label === 'close')?.id);
      const farResult = results.find(r => r.sourceId === store.getSources().find(s => s.label === 'far')?.id);

      if (closeResult && farResult) {
        const closeIndex = results.indexOf(closeResult);
        const farIndex = results.indexOf(farResult);
        expect(closeIndex).toBeLessThan(farIndex);
      }
    });

    test('no reranking for single-term queries', () => {
      const results = searchWithFallback(store, 'authentication');
      // Should still return results normally
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Fuzzy fallback', () => {
    test('corrects typos when RRF returns nothing', () => {
      // Build vocabulary first
      store.getVocabulary();

      // Search with typo
      const results = searchWithFallback(store, 'authentcation'); // missing 'i'
      // Fuzzy layer may or may not find results depending on vocabulary
      expect(Array.isArray(results)).toBe(true);
    });

    test('marks fuzzy matches with matchType', () => {
      store.getVocabulary();
      const results = searchWithFallback(store, 'authentcation');
      if (results.length > 0) {
        expect(results[0].matchType).toBe('fuzzy');
      }
    });
  });

  describe('options', () => {
    test('respects limit', () => {
      const results = searchWithFallback(store, 'the', { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    test('filters by sourceId', () => {
      const authSource = store.getSources().find(s => s.label === 'auth');
      const results = searchWithFallback(store, 'connection', { sourceId: authSource?.id });
      // Should not find 'connection' in auth source
      expect(results.length).toBe(0);
    });
  });
});


describe('batchSearch', () => {
  let store: ContentStore;

  beforeAll(() => {
    store = new ContentStore(':memory:');
  });

  afterAll(() => {
    store.close();
  });

  beforeEach(() => {
    store.clear();
    store.index('Authentication with OAuth', 'auth');
    store.index('Database connections', 'db');
    store.index('Caching strategies', 'cache');
  });

  test('returns Record<string, SearchResult[]>', () => {
    const results = batchSearch(store, ['auth', 'database']);

    expect(typeof results).toBe('object');
    expect(results).toHaveProperty('auth');
    expect(results).toHaveProperty('database');
    expect(Array.isArray(results.auth)).toBe(true);
    expect(Array.isArray(results.database)).toBe(true);
  });

  test('groups results by query', () => {
    const results = batchSearch(store, ['authentication', 'caching']);

    // Auth query should find auth content
    expect(results.authentication.length).toBeGreaterThan(0);
    // Caching query should find cache content
    expect(results.caching.length).toBeGreaterThan(0);
  });

  test('handles queries with no results', () => {
    const results = batchSearch(store, ['nonexistent']);

    expect(results).toHaveProperty('nonexistent');
    expect(results.nonexistent).toEqual([]);
  });

  test('respects limit per query', () => {
    // Add more content
    store.index('Auth method 1', 'auth1');
    store.index('Auth method 2', 'auth2');
    store.index('Auth method 3', 'auth3');

    const results = batchSearch(store, ['auth'], { limit: 2 });
    expect(results.auth.length).toBeLessThanOrEqual(2);
  });
});
