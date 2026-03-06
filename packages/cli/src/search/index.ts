// Types
export type {
  ContentType,
  Chunk,
  SearchResult,
  Source,
  SearchOptions,
  IndexOptions,
} from './types.js';

// Store
export {
  ContentStore,
  getContentStore,
  resetContentStore,
} from './store.js';

// Chunking
export {
  chunkMarkdown,
  chunkPlainText,
  chunkContent,
} from './chunker.js';

// Snippets
export {
  extractSnippet,
  highlightSnippet,
  extractMultipleSnippets,
} from './snippets.js';

// Vocabulary
export {
  getDistinctiveTerms,
  buildVocabulary,
  fuzzyCorrect,
} from './vocabulary.js';

// Search fallback
export {
  searchWithFallback,
  searchWithScope,
  batchSearch,
} from './fallback.js';

// HTML to Markdown
export {
  htmlToMarkdown,
  isHtml,
} from './html-to-markdown.js';
