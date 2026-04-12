import { Database } from 'bun:sqlite';
import type { Chunk, SearchResult, Source, SearchOptions, IndexOptions } from './types.js';
import { chunkContent } from './chunker.js';
import { extractSnippet } from './snippets.js';

/**
 * FTS5 Content Store with BM25 ranking.
 *
 * Uses SQLite FTS5 for full-text search with:
 * - Porter stemming (running -> run)
 * - BM25 ranking (relevance scoring)
 * - Trigram index for substring matching
 */
// Max vocabulary size to prevent unbounded memory
const VOCABULARY_CAP = 10_000;

export class ContentStore {
  private db: Database;
  private vocabulary = new Set<string>();

  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');

    // FTS5 with Porter stemmer for text search
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='porter'
      )
    `);

    // FTS5 with trigram for substring matching
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        tokenize='trigram'
      )
    `);

    // Vocabulary table for fuzzy correction
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      )
    `);
  }

  /**
   * Index content with chunking and store in FTS5.
   */
  index(content: string, sourceLabel: string, options: IndexOptions = {}): number {
    // Get or create source
    let source = this.db.prepare('SELECT id FROM sources WHERE label = ?').get(sourceLabel) as Source | undefined;

    if (source) {
      // Clear existing chunks for this source
      this.db.prepare('DELETE FROM chunks WHERE source_id = ?').run(source.id);
      this.db.prepare('DELETE FROM chunks_trigram WHERE source_id = ?').run(source.id);
    } else {
      this.db.prepare('INSERT INTO sources (label) VALUES (?)').run(sourceLabel);
      source = this.db.prepare('SELECT id FROM sources WHERE label = ?').get(sourceLabel) as Source;
    }

    const sourceId = source.id;
    const contentType = options.contentType ?? 'markdown';
    const chunks = chunkContent(content, contentType, sourceLabel);

    // Batch insert chunks
    const insertChunk = this.db.prepare(
      'INSERT INTO chunks (title, content, source_id, content_type) VALUES (?, ?, ?, ?)'
    );
    const insertTrigram = this.db.prepare(
      'INSERT INTO chunks_trigram (title, content, source_id) VALUES (?, ?, ?)'
    );
    const insertWord = this.db.prepare(
      'INSERT OR IGNORE INTO vocabulary (word) VALUES (?)'
    );

    const tx = this.db.transaction(() => {
      for (const chunk of chunks) {
        const contentType = chunk.hasCode ? 'code' : 'text';
        insertChunk.run(chunk.title, chunk.content, sourceId, contentType);
        insertTrigram.run(chunk.title, chunk.content, sourceId);

        // Build vocabulary (capped to prevent unbounded memory)
        if (this.vocabulary.size < VOCABULARY_CAP) {
          const words = chunk.content.toLowerCase().match(/\b[a-z_][a-z0-9_]*\b/g) || [];
          for (const word of words) {
            if (word.length >= 3 && word.length <= 30 && !this.vocabulary.has(word)) {
              this.vocabulary.add(word);
              insertWord.run(word);
              if (this.vocabulary.size >= VOCABULARY_CAP) break;
            }
          }
        }
      }
    });

    tx();
    return sourceId;
  }

  /**
   * Search using Porter stemming (Layer 1).
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    return this.searchFts('chunks', this.buildFtsQuery(query), 'porter', options);
  }

  /**
   * Search using trigram (Layer 2).
   */
  searchTrigram(query: string, options: SearchOptions = {}): SearchResult[] {
    // Sanitize for trigram too - FTS5 syntax applies to all virtual tables
    return this.searchFts('chunks_trigram', this.sanitizeForFts(query), 'trigram', options);
  }

  /**
   * Internal FTS search - shared by Porter and Trigram.
   */
  private searchFts(
    table: string,
    query: string,
    matchType: 'porter' | 'trigram',
    options: SearchOptions
  ): SearchResult[] {
    const limit = options.limit ?? 10;
    
    // Build source filter for single sourceId or multiple sourceIds
    let sourceFilter = '';
    const params: (string | number)[] = [query];
    
    if (options.sourceIds && options.sourceIds.length > 0) {
      const placeholders = options.sourceIds.map(() => '?').join(', ');
      sourceFilter = `AND source_id IN (${placeholders})`;
      params.push(...options.sourceIds);
    } else if (options.sourceId) {
      sourceFilter = 'AND source_id = ?';
      params.push(options.sourceId);
    }
    
    params.push(limit);
    const bm25Args = table === 'chunks' ? '1.0, 0.75' : '';

    const sql = `
      SELECT
        title,
        snippet(${table}, 1, '**', '**', '...', 64) as snippet,
        bm25(${table}${bm25Args ? ', ' + bm25Args : ''}) as score,
        source_id,
        (SELECT label FROM sources WHERE id = source_id) as source_label
      FROM ${table}
      WHERE ${table} MATCH ?
      ${sourceFilter}
      ORDER BY score
      LIMIT ?
    `;

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<{
        title: string;
        snippet: string;
        score: number;
        source_id: number;
        source_label: string;
      }>;

      return rows.map(row => ({
        title: row.title,
        content: extractSnippet(row.snippet, query),
        score: -row.score, // BM25 returns negative scores
        sourceId: row.source_id,
        sourceLabel: row.source_label,
        matchType,
      }));
    } catch {
      // Query syntax error (e.g., unbalanced quotes)
      return [];
    }
  }

  /**
   * Get all indexed sources with metadata.
   */
  getSources(): Array<{ id: number; label: string; chunkCount: number; indexedAt: number }> {
    const rows = this.db.prepare(`
      SELECT s.id, s.label, s.indexed_at, COUNT(c.rowid) as chunk_count
      FROM sources s
      LEFT JOIN chunks c ON c.source_id = s.id
      GROUP BY s.id
      ORDER BY s.indexed_at DESC
    `).all() as Array<{ id: number; label: string; indexed_at: number; chunk_count: number }>;
    return rows.map(row => ({
      id: row.id,
      label: row.label,
      chunkCount: row.chunk_count,
      indexedAt: row.indexed_at,
    }));
  }

  /**
   * Get source by label.
   */
  getSourceByLabel(label: string): Source | undefined {
    return this.db.prepare('SELECT * FROM sources WHERE label = ?').get(label) as Source | undefined;
  }

  /**
   * Get chunks for a source.
   */
  getChunks(sourceId: number): Chunk[] {
    return this.db.prepare(
      'SELECT title, content FROM chunks WHERE source_id = ?'
    ).all(sourceId) as Chunk[];
  }

  /**
   * Delete a source and its chunks.
   */
  deleteSource(sourceId: number): void {
    this.db.prepare('DELETE FROM chunks WHERE source_id = ?').run(sourceId);
    this.db.prepare('DELETE FROM chunks_trigram WHERE source_id = ?').run(sourceId);
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
  }

  /**
   * Get vocabulary for fuzzy matching.
   */
  getVocabulary(): string[] {
    if (this.vocabulary.size > 0) {
      return Array.from(this.vocabulary);
    }
    // Load from DB if not in memory
    const rows = this.db.prepare('SELECT word FROM vocabulary').all() as Array<{ word: string }>;
    return rows.map(r => r.word);
  }

  /**
   * Get chunk count, optionally for a specific source.
   */
  getChunkCount(sourceId?: number): number {
    const query = sourceId !== undefined
      ? 'SELECT COUNT(*) as count FROM chunks WHERE source_id = ?'
      : 'SELECT COUNT(*) as count FROM chunks';
    const result = sourceId !== undefined
      ? this.db.prepare(query).get(sourceId) as { count: number }
      : this.db.prepare(query).get() as { count: number };
    return result.count;
  }

  /**
   * Remove stale sources older than maxAgeMs.
   */
  cleanupStale(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const stale = this.db.prepare(
      'SELECT id FROM sources WHERE indexed_at < ?'
    ).all(cutoff) as Array<{ id: number }>;
    
    if (stale.length === 0) return 0;
    
    const ids = stale.map(s => s.id);
    this.db.exec(`DELETE FROM chunks WHERE source_id IN (${ids.join(',')})`);
    this.db.exec(`DELETE FROM chunks_trigram WHERE source_id IN (${ids.join(',')})`);
    this.db.exec(`DELETE FROM sources WHERE id IN (${ids.join(',')})`);
    
    return stale.length;
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.db.exec('DELETE FROM chunks');
    this.db.exec('DELETE FROM chunks_trigram');
    this.db.exec('DELETE FROM sources');
    this.db.exec('DELETE FROM vocabulary');
    this.vocabulary.clear();
  }

  /**
   * Close database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get all content from a source (for re-indexing or export).
   */
  getSourceContent(sourceId: number): string {
    const chunks = this.getChunks(sourceId);
    return chunks.map(c => `## ${c.title}\n\n${c.content}`).join('\n\n');
  }

  /**
   * Check if a source exists.
   */
  hasSource(label: string): boolean {
    const result = this.db.prepare('SELECT 1 FROM sources WHERE label = ?').get(label);
    return result !== undefined;
  }

  /**
   * Get distinctive terms using IDF scoring.
   * Returns terms that are relatively unique to this source.
   */
  getDistinctiveTerms(sourceId: number, limit = 10): string[] {
    // Get all terms from this source
    const chunks = this.getChunks(sourceId);
    const sourceTerms = new Map<string, number>();

    for (const chunk of chunks) {
      const words = chunk.content.toLowerCase().match(/\b[a-z_][a-z0-9_]{2,}\b/g) || [];
      for (const word of words) {
        sourceTerms.set(word, (sourceTerms.get(word) || 0) + 1);
      }
    }

    // Score by frequency (simple TF, no IDF needed for single source)
    return Array.from(sourceTerms.entries())
      .filter(([word]) => word.length >= 4) // Skip short words
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word]) => word);
  }

  /**
   * Sanitize query for FTS5 - remove special characters that break syntax.
   * FTS5 special chars: " * - + ( ) ^ ~ : % NEAR AND OR NOT
   */
  private sanitizeForFts(query: string): string {
    return query
      // Remove FTS5 operators and special chars
      .replace(/["%*+\-()^~:]/g, ' ')
      // Collapse multiple spaces
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build FTS5 query from user input.
   * Handles special characters and multi-word queries.
   */
  private buildFtsQuery(query: string): string {
    // Sanitize first to remove FTS5 special chars
    const sanitized = this.sanitizeForFts(query);
    const terms = sanitized
      .split(/\s+/)
      .filter(t => t.length >= 2)
      .map(t => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');

    return terms || `"${sanitized.replace(/"/g, '""')}"`;
  }
}

// Singleton instance
let instance: ContentStore | null = null;

export function getContentStore(): ContentStore {
  if (!instance) {
    instance = new ContentStore();
  }
  return instance;
}

export function resetContentStore(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}