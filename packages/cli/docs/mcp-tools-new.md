# MCX MCP Tools - v0.3.0

Test results after implementing token optimization features.

## Tools Tested

### 1. mcx_list
Lists all available adapters and skills.

**Test:**
```javascript
mcx_list()
```

**Result:**
```json
{
  "adapters": [
    {"name": "alegra", "description": "Alegra API - 233 endpoints", "methodCount": 233},
    {"name": "chrome-devtools", "description": "Chrome DevTools Protocol...", "methodCount": 25},
    {"name": "supabase", "description": "Supabase Management API", "methodCount": 24}
  ],
  "skills": [{"name": "hello", "description": "A simple hello world skill"}],
  "total": {"adapters": 5, "skills": 1}
}
```

**Token Usage:** ~150 tokens

---

### 2. mcx_search

Three search modes available.

#### Mode 1: Spec Exploration (code param)
```javascript
mcx_search({ code: "Object.keys($spec.adapters)" })
```

#### Mode 2: Content Search (queries param)
```javascript
mcx_search({ queries: ["error", "timeout"] })
```

#### Mode 3: Adapter/Method Search
```javascript
mcx_search({ adapter: "supabase", method: "execute_sql" })
```

**Result (exact match):**
```json
{
  "methods": [{
    "adapter": "supabase",
    "method": "execute_sql",
    "typescript": "supabase.execute_sql({ project_id?: string, query?: string, read_only?: boolean }): Promise<unknown>",
    "parameters": {
      "project_id": {"type": "string", "required": false},
      "query": {"type": "string", "required": false},
      "read_only": {"type": "boolean", "required": false, "default": true}
    },
    "example": "await supabase.execute_sql()"
  }]
}
```

**Token Usage:** ~200-750 tokens depending on mode

---

### 3. mcx_execute

Execute code in sandboxed environment with adapter access.

#### Basic Execution
```javascript
mcx_execute({ code: "supabase.list_organizations()" })
```

**Result (v0.2.22+ minimal response):**
```json
{"result": [{"id": "xyz", "name": "papicandela"}, {"id": "abc", "name": "tay"}]}
```

> **v0.2.22 Change:** Removed `metadata`, `storedAs`, `logs`, `executionTime`, `imagesAttached` from response. Only `result` + `truncated` (if true) are returned.

#### With storeAs (Variable Persistence)
```javascript
mcx_execute({ code: "supabase.list_organizations()", storeAs: "orgs" })
// Later:
mcx_execute({ code: "$orgs.length" })  // Returns: 2
```

**Token Usage:** ~100-500 tokens depending on result size

---

### 4. mcx_file (NEW)

Process local files with code. File content available as `$file`.

**Test:**
```javascript
mcx_file({
  path: "package.json",
  code: "({ name: $file.name, version: $file.version, deps: Object.keys($file.dependencies).length })"
})
```

**Result:**
```json
{
  "result": {"name": "@papicandela/mcx-cli", "version": "0.2.21", "deps": 11},
  "truncated": false
}
```

**$file shape:**
- JSON files: parsed object
- Other files: `{ text: string, lines: string[] }`

**Token Usage:** ~50-200 tokens

---

### 5. mcx_batch (NEW)

Run multiple executions and searches in one call. **Bypasses throttling.**

**Test:**
```javascript
mcx_batch({
  executions: [
    { code: "supabase.list_projects()", storeAs: "projects" }
  ],
  queries: ["papicandela"]
})
```

**Result:**
```json
{
  "executions": [{"storeAs": "projects", "success": true}],
  "searches": [],
  "truncated": false
}
```

**Token Usage:** ~100-300 tokens

---

### 6. mcx_stats (NEW)

Session statistics: indexed content, searches, executions, variables.

**Test:**
```javascript
mcx_stats()
```

**Result:**
```
Session Stats
─────────────
Indexed: 0 sources, 0 chunks
Searches: 0 calls (normal)
Executions: 0
Variables: $projects
```

**Token Usage:** ~50 tokens

---

## New Features Summary

### Variable Persistence (storeAs)
- Store execution results: `mcx_execute({ code: "...", storeAs: "myVar" })`
- Access later as `$myVar` in any execution
- Works across mcx_execute, mcx_batch, mcx_file

### Intent Auto-Indexing
- Large outputs (>5KB) with `intent` param are auto-indexed
- Returns snippets instead of full data
- Query indexed content via `mcx_search({ queries: [...] })`

### Search Throttling
- Progressive throttling: 3 calls normal, 4-8 reduced limits, 9+ blocked
- Use `mcx_batch` to bypass throttling

### $file Variable Injection
- mcx_file injects parsed file content as `$file`
- JSON files are automatically parsed
- Text files available as `{ text, lines }`

---

## Bug Fixes Applied

1. **mcx_file structuredContent missing result** - Now includes `result` in structuredContent
2. **mcx_search Mode 1 missing result** - Now includes `result` instead of hardcoded `products`
3. **Variable injection pattern** - Uses MCX sandbox variable injection (not code wrapping)
4. **getAllPrefixed() helper** - Centralized `$` prefix logic in PersistentState class

---

## v0.2.22 Optimizations

### 1. Minimal structuredContent (~70% token savings)
**Before:**
```json
{
  "result": {...},
  "metadata": {"type": "array", "count": 3, "keys": [...]},
  "storedAs": ["result"],
  "logs": [],
  "executionTime": 234.5,
  "truncated": false,
  "imagesAttached": 0
}
```

**After:**
```json
{"result": {...}}
// or with truncation:
{"result": {...}, "truncated": true}
```

### 2. responseSchema in Generated Adapters
The `mcx gen` command now extracts response schemas from OpenAPI 200/201 responses:
```typescript
getUsers: {
  description: 'List users',
  parameters: {},
  responseSchema: {"type":"array","items":{"type":"object","properties":["id","name","email"]}},
  execute: async () => { ... }
}
```

### 3. Safe Params Wrapper
Adapter methods now receive `params ?? {}` instead of raw params, preventing destructuring errors:
```javascript
// Before: supabase.list_tables() → "Cannot destructure property 'project_id' from undefined"
// After:  supabase.list_tables() → "Supabase API (403): Forbidden resource"
```

### 4. Clean Error Messages
Empty logs section removed from errors:
```
// Before: "Execution error: Error message\n\nLogs:\n"
// After:  "Execution error: Error message"
```

---

## Token Efficiency Comparison

| Operation | v0.2.21 | v0.2.22 | Savings |
|-----------|---------|---------|---------|
| List adapters | ~150 | ~150 | 0% |
| Search exact method | ~200 | ~200 | 0% |
| Execute simple | ~400 | ~100 | 75% |
| Execute + large result | ~5000 | ~500 (with intent) | 90% |
| Multiple searches | ~3000 | ~300 (batch) | 90% |
| File processing | ~200 | ~100 | 50% |
| Supabase: list projects + tables | ~1100 | ~150 | 85% |

---

## Changelog

### v0.3.0 (2026-03-06)
Major release with new tools and optimizations.

**New Tools:**
- `mcx_batch` - Multiple operations in one call
- `mcx_file` - Process local files with `$file`
- `mcx_fetch` - Fetch URLs with HTML-to-markdown
- `mcx_stats` - Session statistics

**New Features:**
- Variable persistence (`$result`, `$search`, custom via `storeAs`)
- FTS5 full-text search with auto-indexing
- responseSchema extraction in adapter generator
- Supabase adapter (24 methods)
- Chrome DevTools adapter with native image support

**Performance:**
- Minimal structuredContent (70% token reduction)
- Safe params wrapper prevents destructuring errors
- Clean error messages without empty Logs section

### v0.2.21 (2026-03-05)
- Native MCP image support
- extractImages optimization
