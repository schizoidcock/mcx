# Changelog

All notable changes to MCX will be documented in this file.

## [0.3.12] - 2026-03-30

### New Tools
- **mcx_tree** - JSON tree walker for navigating large results without loading full content
- **mcx_spawn** - Run code in background, returns immediately with task ID
- **mcx_tasks** - List/check background tasks and their results

### Features
- **Silent Method Auto-Correction** - `executeSql` → `execute_sql` automatically (camelCase → snake_case)
- **Default Param Support** - Params with `default` values don't require explicit input
- **Tool Pair Suggestions** - Tools suggest complementary next steps (mcx_find → mcx_grep)
- **Proximity Reranking** - Files near last accessed directory boosted with ★ marker
- **Network Byte Tracking** - Session stats show ↓in ↑out bytes transferred
- **Stale DB Cleanup** - Auto-cleanup FTS5 sources older than 24h on startup
- **Polling Helpers** - `poll()` and `waitFor()` for async operations
- **Auto-compress Variables** - Stale variables (>5min, >1KB) auto-compressed to save context

### Bug Fixes
- Fixed mcx_doctor sandbox test (use `result.value` not `result.data`)
- Fixed isExcludedPath logic (now correctly matches path segments)
- Fixed urlCache unbounded growth (capped at 100 entries)
- Fixed force:true leaking old FTS rows (now deletes old source)
- Fixed fetchWithRetry response body leak (cancel before retry)

---

## [0.3.11] - 2026-03-30

### New Tools
- **mcx_doctor** - Diagnostics: Bun runtime, SQLite/FTS5, adapters, sandbox, FFF, version
- **mcx_upgrade** - Get self-upgrade command for latest version

### Features
- **TTL Cache for URLs** - mcx_fetch caches for 24h, use `force:true` to bypass
- **Retry utilities** - `fetchWithRetry()` and `withRetry()` with jittered exponential backoff

### Internal
- Added `src/utils/retry.ts` with retry utilities
- URL cache tracks sourceId, indexedAt, label

---

## [0.3.10] - 2026-03-30

### Code Quality
- **Shared utilities** - Extracted `FileFinder` type and `coerceJsonArray` to `src/utils/`
- **Consistent path filtering** - New `isExcludedPath()` helper for node_modules/dist checks
- **Memory safety** - Added vocabulary cap (10K words) to prevent unbounded growth
- **WAL checkpoint fix** - Only runs for file-based DBs, not :memory:

---

## [0.3.9] - 2026-03-30

### Improvements
- **WAL Checkpoint on close** - SQLite WAL checkpoint before closing for data consistency
- **Double-JSON coercion** - Fix for Claude Code bug that sends arrays as JSON strings

### Internal
- Added `coerceJsonArray()` helper for robust array parsing in Zod schemas
- Store.close() now runs `PRAGMA wal_checkpoint(TRUNCATE)` before closing

---

## [0.3.8] - 2026-03-30

### New Features
- **mcx_related** - New tool to find related files by analyzing imports/exports
  - Shows files that the target imports
  - Shows files that import the target
  - Shows sibling files with similar names
  - Filters out node_modules automatically

- **Smart adapter discovery** in `mcx gen`
  - Auto-discovers OpenAPI specs (yaml/json) and SDK files when no source provided
  - Interactive selection from discovered sources
  - Uses FFF for fast file search

### Performance
- Parallelized file existence checks in import resolution (8 extensions checked concurrently)
- Parallelized import resolution for mcx_related
- Hoisted IMPORT_REGEX to module scope (avoids recreation per call)

### Code Quality
- Consolidated FileFinder type definitions (gen.ts now uses same pattern as serve.ts)
- Added RelationType union type for type-safe relation handling
- Fixed FFF `basePath` parameter (was incorrectly using `root`)

---

## [0.3.7] - 2026-03-30

### FFF Deep Integration (Phase 2)
- **Fuzzy path resolution** in mcx_file - partial paths resolved via FFF
- **Method frecency tracking** in mcx_search - frequently used methods ranked higher
- **Auto-fetch error context** - stack traces show source code automatically

### Bug Fixes
- Fixed FFF native binary auto-install via optionalDependencies
- Added platform binaries for darwin-arm64, darwin-x64, linux-x64-gnu, win32-x64

---

## [0.3.6] - 2026-03-29

### Testing
- Added comprehensive tests for security utilities (SSRF, env denylist)
- Added tests for generator features (method names, URL encoding)
- 145 tests total, 251 assertions

### Infrastructure
- FFF cleanup on server shutdown
- Graceful handling when FFF binary unavailable

---

## [0.3.5] - 2026-03-28

### Generator Improvements
- Improved generated adapter method names (cleaner, more idiomatic)
- URL-safe path parameter encoding with encodeURIComponent

### Refactoring
- Simplified SSRF and environment key security checks
- Extracted security utilities to `src/utils/security.ts`

---

## [0.3.4] - 2026-03-27

### New Features
- **FFF Integration** - Fast File Finder for SIMD-accelerated search
  - `mcx_find` - Fuzzy file search with frecency ranking
  - `mcx_grep` - Content search across files
- Auto-select context parameter in generated adapters
- Auto-select pattern for chrome-devtools and supabase adapters

### Security
- SSRF protection - blocks private IPs, cloud metadata endpoints, localhost
- Environment variable denylist - blocks ~45 dangerous vars (NODE_OPTIONS, LD_PRELOAD, etc.)
- Output hard cap at 100MB

---

## [0.3.3] - 2026-03-09

### Advanced Tool Use (Anthropic Best Practices)

#### input_examples
- Added `example` field to `ParameterDefinition` type in core
- Generated adapters now include example values from OpenAPI specs
- Examples flow through to `mcx_search` for better LLM understanding

#### deferred_loading (Lazy Adapters)
- Adapters from `~/.mcx/adapters/` are now lazy-loaded
- Only metadata extracted at startup (name, description, methods)
- Full adapter loaded on first method call
- Reduces startup time and memory for large adapter collections

#### domain_hints
- Added `domain` field to `Adapter` interface
- Automatic domain inference from adapter name/description
- `generateTypesSummary` groups adapters by domain when 4+ adapters present
- Domains: payments, database, email, storage, auth, ai, messaging, devtools

### Example Output

Before (flat list):
```
- stripe (12 methods)
- supabase (24 methods)
- sendgrid (8 methods)
```

After (grouped by domain):
```
[payments] stripe(12)
[database] supabase(24)
[email] sendgrid(8)
```

---

## [0.3.2] - 2026-03-08

### Developer Experience
- **Fuzzy method suggestions** - When calling undefined adapter methods, MCX now suggests similar methods using Levenshtein distance
  - `supabase.executeSql()` → "Did you mean: execute_sql?"
  - `supabase.listProjects()` → "Did you mean: list_projects?"
  - Unknown methods show available methods list

---

## [0.3.1] - 2026-03-07

### Bug Fixes
- **camelCase aliases** for kebab-case adapters (`chrome-devtools` → `chromeDevtools`)
- **Image metadata** returned instead of null for screenshots (`{ __image__: true, mimeType, size }`)
- Updated mcx_execute description with clear adapter usage examples

---

## [0.3.0] - 2026-03-06

### Major Features

#### New MCP Tools
- **mcx_batch** - Execute multiple operations in a single call, bypasses throttling
- **mcx_file** - Process local files with code (`$file` variable injection)
- **mcx_fetch** - Fetch URLs with automatic HTML-to-markdown conversion and indexing
- **mcx_stats** - Session statistics (indexed content, searches, executions, variables)

#### Variable Persistence
- Results auto-stored as `$result` after every execution
- Custom variable names via `storeAs` parameter
- Variables persist across executions: `$invoices`, `$customers`, etc.
- Special commands: `$clear` (clear all), `delete $varname` (delete specific)

#### FTS5 Full-Text Search
- Auto-index large outputs (>5KB) when `intent` parameter is specified
- Search indexed content via `mcx_search({ queries: [...] })`
- BM25 ranking with vocabulary-aware fallback
- Chunk-based indexing with smart snippet extraction

#### Search Modes (mcx_search)
- **Mode 1**: Spec exploration with JS code (`$spec.adapters.stripe.tools`)
- **Mode 2**: FTS5 content search on indexed data
- **Mode 3**: Adapter/method search with exact match detection

### New Adapters
- **supabase** - Supabase Management API (24 methods)
  - Projects, tables, functions, secrets, edge functions
  - SQL execution with read-only mode
- **chrome-devtools** - Chrome DevTools Protocol (25 methods)
  - Screenshots, navigation, DOM manipulation
  - Network monitoring, console access
  - Native MCP image support for token-efficient screenshots

### Generator Improvements (mcx gen)
- **responseSchema** extraction from OpenAPI 200/201 responses
- Smart example values based on parameter names
- Respect OpenAPI `required` field defaults
- Interactive TUI mode with filtering

### Performance Optimizations
- **Minimal structuredContent** - Removed metadata, logs, executionTime overhead (~70% token savings)
- **Safe params wrapper** - Prevents destructuring errors on empty params
- **Clean error messages** - No empty "Logs:" section
- **extractImages optimization** - Fast paths for common cases

### Token Efficiency
| Operation | Before | After | Savings |
|-----------|--------|-------|---------|
| mcx_execute response | ~400 | ~100 | 75% |
| Supabase: list projects + tables | ~1100 | ~150 | 85% |
| Large result with intent | ~5000 | ~500 | 90% |

### New Modules
- `sandbox/` - Executor, state management, result truncation
- `search/` - FTS5 store, chunker, vocabulary, HTML-to-markdown
- `spec/` - OpenAPI spec loader, caching, requires inference

### Bug Fixes
- Fixed MCP image support for screenshots
- Fixed extractImages with cleaner output
- Fixed search throttling edge cases
- Fixed variable injection in sandbox

### Infrastructure
- File logging with `mcx logs` command
- Global error handlers to prevent silent crashes
- Path utilities for consistent `~/.mcx/` handling

---

## [0.2.21] - 2026-03-05
- feat: Native MCP image support for token-efficient screenshots
- fix: Optimize extractImages with fast paths

## [0.2.20] - 2026-03-04
- refactor: Extract handleCommand helper
- fix: Address code review issues in logging
- feat: Add file logging and mcx logs command

## [0.2.19] - 2026-03-03
- feat: Show detailed params only on exact method match
- fix: HTTP error handling for MCP transport

## [0.2.18] - 2026-03-02
- Initial public release
