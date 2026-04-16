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
export const FILE_READ_CODE = FILE_READ_PARTS.join(';') + ';';

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

/** Run cleanup every N tool calls */
export const CLEANUP_INTERVAL = 50;

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
