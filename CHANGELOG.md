# Changelog

All notable changes to MCX will be documented in this file.

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
