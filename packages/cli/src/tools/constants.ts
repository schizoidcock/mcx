/**
 * Shared Constants
 * 
 * Centralized thresholds and limits used across tools.
 * Source of truth - import from here, don't duplicate.
 */

// ============================================================================
// Output Thresholds
// ============================================================================

/** Auto-index outputs larger than this (bytes) */
export const AUTO_INDEX_THRESHOLD = 50_000;

/** Require intent param for outputs larger than this (bytes) */
export const INTENT_THRESHOLD = 5_000;

/** Auto-index files larger than this (bytes) */
export const FILE_INDEX_THRESHOLD = 10_000;

/** Require intent param for outputs larger than this (bytes) */

/** Auto-index large outputs instead of truncating (bytes) */
export const FORMAT_INDEX_THRESHOLD = 20_000;

/** Large output threshold - show if smaller, just header if larger (100KB) */
export const LARGE_OUTPUT_THRESHOLD = 102_400;

/** Adapter result truncation threshold (chars) */
export const ADAPTER_TRUNCATE_THRESHOLD = 3000;

/** Adapter result display limit (chars) */
export const ADAPTER_DISPLAY_LIMIT = 2000;

/** Max items to show in tree format */
export const TREE_MAX_ITEMS = 10;

/** Keys to use as ID in tree format (priority order) */
export const TREE_ID_KEYS = ['id', 'name', 'number', 'title'];

/** Keys to extract as status in tree format */
export const TREE_STATUS_KEYS = ['status', 'state'];

/** Keys to extract as amount in tree format */
export const TREE_AMOUNT_KEYS = ['total', 'amount'];

/** Keys to extract as date in tree format */
export const TREE_DATE_KEYS = ['date', 'created_at'];

// ============================================================================
// Formatter Limits
// ============================================================================

/** Max items to show in formatted output */
export const FORMAT_MAX_ITEMS = 10;

/** Max title/string length in formatted output */
export const FORMAT_MAX_TITLE = 50;

/** Max array items in preview */
export const FORMAT_ARRAY_PREVIEW = 3;

/** Max object keys in preview */
export const FORMAT_KEYS_PREVIEW = 5;

/** Max relevant lines in diff */
export const FORMAT_MAX_RELEVANT = 20;
// ============================================================================
// Character Limits
// ============================================================================

/** Max output characters before truncation */
export const CHARACTER_LIMIT = 25_000;

/** Max line width for grep output */
export const GREP_MAX_LINE_WIDTH = 100;

/** Max matches per file for grep */
export const GREP_MAX_PER_FILE = 5;

/** Max grep results page size */
export const GREP_PAGE_SIZE = 200;

/** Max line width for general output */
export const MAX_LINE_WIDTH = 120;

/** Max log entries to show */
export const MAX_LOGS = 20;

// ============================================================================
// Snippet Extraction
// ============================================================================

/** Window size for snippet extraction (chars before/after match) */
export const SNIPPET_WINDOW = 300;

/** Max snippets to extract for multi-word queries */
export const MAX_SNIPPETS = 3;

/** Min term length to consider in snippet extraction */
export const MIN_TERM_LENGTH = 2;

/** Snippet length for intent-based search results */
export const INTENT_SNIPPET_LENGTH = 150;

/** Merge snippet windows if gap is smaller than this (chars) */
export const SNIPPET_MERGE_GAP = 50;

/** Max size of merged snippet window (chars) */
export const SNIPPET_MAX_MERGED = 800;

/** Adaptive snippet sizes - total chars based on query context */
export const SNIPPET_MAX_BATCH = 2000;    // Few queries, more detail
export const SNIPPET_MAX_REGULAR = 1000;  // Many queries, less detail
// ============================================================================
// Warnings
// ============================================================================

/** Warn when reading full file larger than this (bytes) */
export const FULL_FILE_WARNING_BYTES = 5_000;

/** Code patterns that read full file (trigger warning) */
export const FULL_FILE_CODE = new Set([
  '$file',
  '$file.text',
  '$file.lines',
]);

// ============================================================================
// Sandbox File Reading (used by mcx_file)
// ============================================================================

/** Code parts to read file inside sandbox (enables I/O tracking) */
const FILE_READ_PARTS = [
  'const __c = await Bun.file("PATH").text()',
  "const __l = __c.split('\\n').map((l, i) => (i + 1) + ': ' + l)",
  'const $file = Object.create(null)',
  '$file.text = __l.join("\\n")',
  '$file.lines = __l',
  '$file.path = "PATH"',
];

/** Joined code template for sandbox file reading */
export const FILE_READ_CODE = `${FILE_READ_PARTS.join(';')};`;

/** Build code to read a file inside sandbox */
export function buildReadCode(escapedPath: string): string {
  return FILE_READ_CODE.replace(/PATH/g, escapedPath);
}

// ============================================================================
// Import Parsing (used by mcx_find related mode)
// ============================================================================

/** Regex to extract import/require paths */
export const IMPORT_REGEX = /(?:import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

/** Extensions to try when resolving imports */
export const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/** Source file extensions (glob pattern) */
export const SOURCE_GLOB = "*.{ts,tsx,js,jsx}";

/** Source file extensions (regex) */
export const SOURCE_EXT_REGEX = /\.(ts|tsx|js|jsx)$/;

/** Max grep results for related files search */
export const RELATED_PAGE_SIZE = 500;

// ============================================================================
// Rate Limiting / Throttling
// ============================================================================

/** Throttle after N accesses to same file */
export const THROTTLE_AFTER = 3;

/** Block after N accesses to same file */
export const BLOCK_AFTER = 8;

/** Throttle window in milliseconds */
export const THROTTLE_WINDOW_MS = 60_000;

/** Map entry TTL in milliseconds */
export const MAP_TTL_MS = 30 * 60 * 1000;

/** Max entries in tracking maps */
export const MAP_MAX_ENTRIES = 500;

/** Max watched projects (FileFinder instances) */
export const MAX_WATCHED_PROJECTS = 20;

/** Run cleanup every N tool calls */
export const CLEANUP_INTERVAL = 50;

/** Max chunks in ContentStore before eviction */
export const MAX_CHUNKS = 5000;

/** Max bytes per chunk before splitting */
export const MAX_CHUNK_BYTES = 4096;

/** Content stale after this time (30 min, same as MAP_TTL_MS) */
export const CONTENT_STALE_MS = 30 * 60 * 1000;

// ============================================================================
// Adapter Method Display
// ============================================================================

/** Max params to show in full detail view */
export const MAX_PARAMS_FULL = 10;

/** Max params when truncating */
export const MAX_PARAMS_TRUNCATED = 8;

/** Max description length before truncating */
export const MAX_DESC_LENGTH = 80;

// ============================================================================
// Background Tasks
// ============================================================================

/** Max concurrent background tasks */
export const MAX_BACKGROUND_TASKS = 20;

/** Background task TTL in milliseconds (30 min) */
export const TASK_TTL_MS = 30 * 60 * 1000;

/** Max response body size for fetch (100KB) */
export const MAX_RESPONSE_BODY = 100_000;

// ============================================================================
// Process Execution
// ============================================================================

/** Hard cap for process output (100MB) */
export const HARD_CAP_BYTES = 100 * 1024 * 1024;

/** Default timeout for shell commands (30s) */
export const DEFAULT_TIMEOUT = 30_000;

// ============================================================================
// Daemon
// ============================================================================

/** Poll interval for checking FFF changes (ms) */
export const DAEMON_POLL_INTERVAL_MS = 1000;

/** Extensions to index content for */
export const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.yaml', '.yml',
  '.html', '.css', '.scss', '.less',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.prisma',
]);

// ============================================================================
// Score Normalization
// ============================================================================

/** Normalize a score to 0-100 range */
export const normalizeScore = (value: number, max: number): number =>
  Math.min(value / max, 1) * 100;

