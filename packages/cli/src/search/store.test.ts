import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { ContentStore } from './store';

describe('ContentStore', () => {
  let store: ContentStore;

  beforeAll(() => {
    store = new ContentStore(':memory:');
  });

  afterAll(() => {
    store.close();
  });

  beforeEach(() => {
    store.clear();
  });

  describe('index()', () => {
    test('indexes content and returns source ID', () => {
      const sourceId = store.index('Hello world', 'test-source');
      expect(sourceId).toBeGreaterThan(0);
    });

    test('creates chunks from content', () => {
      const sourceId = store.index('# Header\nSome content', 'test-source');
      const chunks = store.getChunks(sourceId);
      expect(chunks.length).toBeGreaterThan(0);
    });

    test('tracks chunk count in source metadata', () => {
      // 3 paragraphs separated by blank lines = 3 chunks
      const sourceId = store.index('Line 1\n\nLine 2\n\nLine 3', 'test-source');
      const count = store.getChunkCount(sourceId);
      expect(count).toBe(3);
    });
  });

  describe('search()', () => {
    beforeEach(() => {
      store.index('# Authentication\nUse bearer tokens for API access', 'auth-docs');
      store.index('# Database\nConnect to PostgreSQL using connection string', 'db-docs');
    });

    test('finds content by keyword', () => {
      const results = store.search('authentication');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].sourceLabel).toBe('auth-docs');
    });

    test('returns empty array for non-matching query', () => {
      const results = store.search('nonexistentterm12345');
      expect(results).toEqual([]);
    });

    test('respects limit option', () => {
      store.index('Auth method 1', 'auth1');
      store.index('Auth method 2', 'auth2');
      store.index('Auth method 3', 'auth3');

      const results = store.search('auth', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test('filters by sourceId', () => {
      const sourceId = store.index('Special auth content', 'special');
      const results = store.search('auth', { sourceId });
      expect(results.every(r => r.sourceId === sourceId)).toBe(true);
    });
  });

  describe('searchTrigram()', () => {
    beforeEach(() => {
      store.index('Authentication with OAuth2', 'oauth-docs');
    });

    test('finds partial matches', () => {
      const results = store.searchTrigram('auth');
      expect(results.length).toBeGreaterThan(0);
    });

    test('finds substring matches', () => {
      const results = store.searchTrigram('OAuth');
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('getSources()', () => {
    test('returns all indexed sources', () => {
      store.index('Content 1', 'source-1');
      store.index('Content 2', 'source-2');

      const sources = store.getSources();
      expect(sources.length).toBe(2);
      expect(sources.map(s => s.label)).toContain('source-1');
      expect(sources.map(s => s.label)).toContain('source-2');
    });

    test('includes metadata in sources', () => {
      store.index('Test content', 'test-label');
      const sources = store.getSources();

      expect(sources[0]).toHaveProperty('id');
      expect(sources[0]).toHaveProperty('label');
      expect(sources[0]).toHaveProperty('chunkCount');
      expect(sources[0]).toHaveProperty('indexedAt');
    });
  });

  describe('deleteSource()', () => {
    test('removes source and its chunks', () => {
      const sourceId = store.index('To be deleted', 'delete-me');
      expect(store.getSources().length).toBe(1);

      store.deleteSource(sourceId);
      expect(store.getSources().length).toBe(0);
    });
  });

  describe('getVocabulary()', () => {
    test('builds vocabulary from indexed content', () => {
      store.index('authentication authorization bearer_token', 'vocab-test');
      const vocab = store.getVocabulary();

      expect(vocab.has('authentication')).toBe(true);
      expect(vocab.has('authorization')).toBe(true);
      expect(vocab.has('bearer_token')).toBe(true);
    });

    test('filters short words', () => {
      store.index('a ab abc abcd', 'short-words');
      const vocab = store.getVocabulary();

      expect(vocab.has('a')).toBe(false);
      expect(vocab.has('ab')).toBe(false);
      expect(vocab.has('abc')).toBe(true);
    });
  });

  describe('clear()', () => {
    test('removes all data', () => {
      store.index('Content 1', 'source-1');
      store.index('Content 2', 'source-2');

      store.clear();

      expect(store.getSources().length).toBe(0);
      expect(store.getVocabulary().size).toBe(0);
    });
  });
});
