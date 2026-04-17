/** Content type for indexing */
export type ContentType = 'markdown' | 'plaintext' | 'json';

export interface Chunk {
  title: string;
  content: string;
  sourceId?: number;
  hasCode?: boolean;
}

export interface SearchResult {
  title: string;
  snippet: string;
  score: number;
  sourceId: number;
  sourceLabel: string;
  matchType?: 'porter' | 'trigram' | 'fuzzy';
}

export interface Source {
  id: number;
  label: string;
  chunkCount: number;
  codeChunkCount: number;
  indexedAt: Date;
}

export interface SearchOptions {
  limit?: number;
  sourceId?: number;
  sourceIds?: number[];  // For scoped queries across multiple sources
  sourceLabel?: string;
}

export interface IndexOptions {
  /** Override auto-detected content type */
  contentType?: ContentType;
  /** Lines per chunk for plaintext (default: 20) */
  linesPerChunk?: number;
}

/** Window range for snippet extraction with match count */
export interface SnippetWindow {
  start: number;
  end: number;
  matches: number;
}