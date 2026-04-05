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
// Max vocabulary size to prevent unbounded memory growth
const VOCABULARY_CAP = 10000;

export class ContentStore {
  private db: Database;
  private vocabulary: Set<string>;
  private isFileDb: boolean;

  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.vocabulary = new Set();
    this.isFileDb = dbPath !== ':memory:';
    this.initialize();
  }

  private initialize(): void {
    // Sources metadata
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER DEFAULT 0,
        code_chunk_count INTEGER DEFAULT 0,
        indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // FTS5 with Porter stemming
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title, content, source_id UNINDEXED, content_type UNINDEXED,
        tokenize='porter unicode61'
      )
    `);

    // FTS5 with trigram for substring matching
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title, content, source_id UNINDEXED,
        tokenize='trigram'
      )
    `);

    // Vocabulary for fuzzy correction
    this.db.run(`
      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      )
    `);
  }

  /**
   * Delete source by label. Returns true if found and deleted.
   */
  deleteByLabel(label: string): boolean {
    const source = this.db.prepare('SELECT id FROM sources WHERE label = ?').get(label) as { id: number } | undefined;
    if (!source) return false;
    
    // Delete chunks first (FTS5 tables)
    this.db.prepare('DELETE FROM chunks_fts WHERE source_id = ?').run(source.id);
    this.db.prepare('DELETE FROM chunks_trigram WHERE source_id = ?').run(source.id);
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(source.id);
    return true;
  }

  /**
   * Re-index content (delete old, insert new). Returns new source ID.
   */
  reindex(content: string, label: string, options: IndexOptions = {}): number {
    this.deleteByLabel(label);
    return this.index(content, label, options);
  }

  /**
   * Index content and return source ID.
   */
  index(content: string, label: string, options: IndexOptions = {}): number {
    const chunks = chunkContent(content, options.contentType, options.linesPerChunk);
    return this.indexChunks(chunks, label);
  }

  /**
   * Index pre-chunked content.
   */
  indexChunks(chunks: Chunk[], label: string): number {
    // Create source
    const sourceResult = this.db.prepare(
      'INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES (?, ?, ?)'
    ).run(label, chunks.length, chunks.filter(c => c.hasCode).length);

    const sourceId = Number(sourceResult.lastInsertRowid);

    // Insert chunks
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
            if (word.length >= 3) {
              insertWord.run(word);
              this.vocabulary.add(word);
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
    return this.searchFts('chunks_trigram', query, 'trigram', options);
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
    const sourceFilter = options.sourceId ? 'AND source_id = ?' : '';
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

    const params = options.sourceId ? [query, options.sourceId, limit] : [query, limit];

    const rows = this.db.prepare(sql).all(...params) as Array<{
      title: string;
      snippet: string;
      score: number;
      source_id: number;
      source_label: string;
    }>;

    return rows.map(row => ({
      title: row.title,
      snippet: row.snippet,
      score: Math.abs(row.score),
      sourceId: row.source_id,
      sourceLabel: row.source_label,
      matchType,
    }));
  }

  /**
   * Get vocabulary for fuzzy correction.
   */
  getVocabulary(): Set<string> {
    if (this.vocabulary.size > 0) return this.vocabulary;

    const rows = this.db.prepare('SELECT word FROM vocabulary').all() as Array<{ word: string }>;
    for (const row of rows) {
      this.vocabulary.add(row.word);
    }

    return this.vocabulary;
  }

  /**
   * Get all sources.
   */
  getSources(): Source[] {
    const rows = this.db.prepare(`
      SELECT id, label, chunk_count, code_chunk_count, indexed_at
      FROM sources ORDER BY indexed_at DESC
    `).all() as Array<{
      id: number;
      label: string;
      chunk_count: number;
      code_chunk_count: number;
      indexed_at: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      label: row.label,
      chunkCount: row.chunk_count,
      codeChunkCount: row.code_chunk_count,
      indexedAt: new Date(row.indexed_at),
    }));
  }

  /**
   * Get chunk count for a source.
   */
  getChunkCount(sourceId: number): number {
    const row = this.db.prepare(
      'SELECT chunk_count FROM sources WHERE id = ?'
    ).get(sourceId) as { chunk_count: number } | undefined;

    return row?.chunk_count ?? 0;
  }

  /**
   * Get chunks for a source (for vocabulary extraction).
   */
  getChunks(sourceId: number): Chunk[] {
    const rows = this.db.prepare(
      'SELECT title, content FROM chunks WHERE source_id = ?'
    ).all(sourceId) as Array<{ title: string; content: string }>;

    return rows.map(row => ({
      title: row.title,
      content: row.content,
    }));
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
   * Clean up stale sources older than maxAgeMs.
   * Returns number of sources deleted.
   */
  cleanupStale(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const stale = this.db.prepare(
      'SELECT id FROM sources WHERE indexed_at < ?'
    ).all(cutoff) as Array<{ id: number }>;

    for (const { id } of stale) {
      this.deleteSource(id);
    }

    return stale.length;
  }

  /**
   * Get database stats for diagnostics.
   */
  getStats(): { sources: number; chunks: number; vocabulary: number } {
    const sources = (this.db.prepare('SELECT COUNT(*) as c FROM sources').get() as { c: number }).c;
    const chunks = (this.db.prepare('SELECT COUNT(*) as c FROM chunks').get() as { c: number }).c;
    return {
      sources,
      chunks,
      vocabulary: this.vocabulary.size,
    };
  }

  /**
   * Clear all data.
   */
  clear(): void {
    this.db.run('DELETE FROM chunks');
    this.db.run('DELETE FROM chunks_trigram');
    this.db.run('DELETE FROM sources');
    this.db.run('DELETE FROM vocabulary');
    this.vocabulary.clear();
  }

  /**
   * Close the database connection.
   * Runs WAL checkpoint for file-based DBs.
   */
  close(): void {
    if (this.isFileDb) {
      try {
        this.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Ignore checkpoint errors on close
      }
    }
    this.db.close();
  }

  /**
   * Build FTS5 query from user input.
   * Handles special characters and multi-word queries.
   */
  private buildFtsQuery(query: string): string {
    // Split into terms and escape special chars
    const terms = query
      .split(/\s+/)
      .filter(t => t.length >= 2)
      .map(t => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');

    return terms || `"${query.replace(/"/g, '""')}"`;
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
