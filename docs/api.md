# Programmatic API

Use MCX programmatically in your own applications.

## Basic Usage

```typescript
import { createExecutor } from '@papicandela/mcx-core';

const executor = createExecutor();
await executor.loadConfig('./mcx.config.ts');

// Execute code
const result = await executor.execute(`
  const data = await api.getRecords({ limit: 10 });
  return pick(data, ['id', 'name']);
`);

// Run a skill
const skillResult = await executor.runSkill('daily-summary', {
  inputs: { date: '2024-01-15' },
});
```

## MCXExecutor Methods

| Method | Description |
|--------|-------------|
| `loadConfig(path?)` | Load configuration from file |
| `registerAdapter(adapter)` | Register an adapter |
| `unregisterAdapter(name)` | Remove an adapter |
| `getAdapter(name)` | Get adapter by name |
| `getAdapterNames()` | List all adapter names |
| `registerSkill(skill)` | Register a skill |
| `unregisterSkill(name)` | Remove a skill |
| `getSkill(name)` | Get skill by name |
| `getSkillNames()` | List all skill names |
| `execute(code, options?)` | Execute code in sandbox |
| `runSkill(name, options?)` | Run a skill |
| `configureSandbox(config)` | Update sandbox defaults |

## MCP Tools

MCX exposes sixteen tools to the AI agent:

| Tool | Description |
|------|-------------|
| `mcx_execute` | Execute code in sandbox, auto-stores result as `$result` |
| `mcx_search` | 3 modes: spec exploration, FTS5 search, adapter/method search |
| `mcx_batch` | Multiple executions/searches in one call (bypasses throttling) |
| `mcx_file` | Process local files with `$file` injection, auto-indexes files >1KB |
| `mcx_fetch` | Fetch URLs with HTML-to-markdown and auto-indexing (24h TTL cache) |
| `mcx_find` | Fast fuzzy file search with frecency + proximity ranking |
| `mcx_grep` | SIMD-accelerated content search with proximity ranking |
| `mcx_related` | Find related files by analyzing imports/exports |
| `mcx_list` | List available adapters and skills |
| `mcx_stats` | Session statistics (indexed content, variables, network) |
| `mcx_tree` | Navigate large JSON results without loading full content |
| `mcx_spawn` | Run code in background, returns task ID immediately |
| `mcx_tasks` | List/check background tasks and their results |
| `mcx_run_skill` | Run a named skill with optional inputs |
| `mcx_doctor` | Run diagnostics (Bun, SQLite, adapters, sandbox, FFF) |
| `mcx_upgrade` | Get self-upgrade command for latest version |

### mcx_execute Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `code` | string | required | JavaScript/TypeScript code to execute |
| `storeAs` | string | - | Store result as variable (e.g., `"invoices"` → `$invoices`) |
| `intent` | string | - | Auto-index large outputs (>5KB) and search with this intent |
| `truncate` | boolean | `true` | Enable/disable result truncation |
| `maxItems` | number | `10` | Max array items when truncating |
| `maxStringLength` | number | `500` | Max string length when truncating |

### Variable Persistence

Results are automatically stored and accessible in subsequent executions:

```javascript
// First execution - auto-stored as $result
mcx_execute({ code: "supabase.list_projects()", storeAs: "projects" })

// Later - access stored variables
mcx_execute({ code: "$projects.filter(p => p.status === 'ACTIVE_HEALTHY')" })

// Special commands
mcx_execute({ code: "$clear" })           // Clear all variables
mcx_execute({ code: "delete $projects" }) // Delete specific variable
```

### mcx_search

Three search modes for different use cases:

**Mode 1: Spec Exploration** - Query the cached OpenAPI spec with JavaScript:
```typescript
mcx_search({ code: "Object.keys($spec.adapters)" })
mcx_search({ code: "$spec.adapters.supabase.tools.list_tables" })
```

**Mode 2: FTS5 Content Search** - Search indexed content from executions:
```typescript
mcx_search({ queries: ["error", "timeout"] })
mcx_search({ queries: ["invoice"], source: "exec_1" })
```

**Mode 3: Adapter/Method Search** - Discover APIs:
```typescript
mcx_search({ adapter: "supabase" })                    // List all methods
mcx_search({ adapter: "supabase", method: "list" })    // Partial match
mcx_search({ adapter: "supabase", method: "list_tables" }) // Exact → detailed params
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | string | Mode 1: JS code to explore `$spec` |
| `queries` | string[] | Mode 2: FTS5 search queries |
| `adapter` | string | Mode 3: Filter by adapter name |
| `method` | string | Mode 3: Filter by method name |
| `query` | string | Search term for names/descriptions |
| `storeAs` | string | Store results as variable, return summary only |
| `limit` | number | Max results per category (default: 20) |

**Token optimization:** Results auto-stored in `$search`. Use `storeAs` to get minimal response.

### mcx_batch

Execute multiple operations in one call, bypassing throttling:

```typescript
mcx_batch({
  executions: [
    { code: "supabase.list_projects()", storeAs: "projects" },
    { code: "supabase.list_organizations()", storeAs: "orgs" }
  ],
  queries: ["error"]  // Optional FTS5 searches
})
```

### mcx_file

Process local files with `$file` variable injection. Files >1KB are automatically indexed in FTS5 for later search via `mcx_search`.

**Store-only mode** (no code parameter): Loads file into sandbox variable without returning content to context. Ideal for large files.

```typescript
// Store-only: 142KB file → only 50 chars to context
mcx_file({ path: "serve.ts", storeAs: "src" })
// → "Stored as $src (3788 lines, 142670 chars)"

// Query stored file with helpers
mcx_execute({ code: "outline($src).slice(0, 10)" })
mcx_execute({ code: "grep($src, 'registerTool', 3)" })
mcx_execute({ code: "block($src, 2467)" })

// Process mode (with code): executes code and returns result
mcx_file({
  path: "package.json",
  code: "({ name: $file.name, deps: Object.keys($file.dependencies) })"
})
// $file is parsed JSON for .json files, { text, lines } for others
// HTML files are converted to markdown before indexing
```

**File Query Helpers** (available after storing a file):

| Helper | Usage | Description |
|--------|-------|-------------|
| `around(file, line, ctx)` | `around($src, 100, 5)` | Lines around line 100 (±5 context) |
| `block(file, line)` | `block($src, 100)` | Extract code block containing line 100 |
| `grep(file, pattern, ctx)` | `grep($src, 'TODO', 3)` | Find matches with 3 lines context |
| `outline(file)` | `outline($src)` | Extract function/class signatures |

### mcx_fetch

Fetch URLs with automatic HTML-to-markdown conversion:

```typescript
mcx_fetch({
  url: "https://docs.example.com/api",
  code: "$content.split('## ').length"  // $content is markdown
})
```

### mcx_find

Fast fuzzy file search powered by FFF (Fast File Finder):

```typescript
mcx_find({ query: "serve.ts" })           // Fuzzy match filename
mcx_find({ query: "*.ts" })               // Extension filter
mcx_find({ query: "!test" })              // Exclude pattern
mcx_find({ query: "src/" })               // Path contains
mcx_find({ query: "status:modified" })    // Git modified files
mcx_find({ query: "config", limit: 5 })   // Limit results
```

Results are ranked by match score + frecency (recently accessed files boosted) + git status.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search query (supports glob, exclusion, path filters) |
| `pattern` | string | - | Alias for `query` (for compatibility) |
| `path` | string | cwd | Directory to search in (absolute path) |
| `limit` | number | `20` | Max results to return |

### mcx_grep

SIMD-accelerated content search across files:

```typescript
mcx_grep({ query: "TODO" })                    // Plain text search
mcx_grep({ query: "*.ts useState" })           // Search in TypeScript files
mcx_grep({ query: "src/ handleClick" })        // Search in directory
mcx_grep({ query: "error", mode: "regex" })    // Regex mode
mcx_grep({ query: "improt", mode: "fuzzy" })   // Typo-tolerant fuzzy
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search pattern (prefix with `*.ext` or `path/` to filter) |
| `pattern` | string | - | Alias for `query` (for compatibility) |
| `path` | string | cwd | Directory to search in (absolute path) |
| `mode` | string | `"plain"` | Search mode: `plain`, `regex`, or `fuzzy` |
| `limit` | number | `50` | Max matches to return |

### mcx_related

Find files related to a given file by analyzing imports and exports:

```typescript
mcx_related({ file: "src/commands/serve.ts" })
// Returns:
// - Files that this file imports
// - Files that import this file
// - Sibling files with similar names (e.g., serve.test.ts)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `file` | string | File path to find related files for |

Useful for understanding code dependencies before making changes.

## Built-in Helpers

Functions available in the sandbox for efficient data handling:

| Helper | Usage | Description |
|--------|-------|-------------|
| `pick(arr, fields)` | `pick(data, ['id', 'name'])` | Extract specific fields (supports dot-notation: `'address.city'`) |
| `first(arr, n)` | `first(data, 5)` | First N items (default: 5) |
| `sum(arr, field)` | `sum(data, 'amount')` | Sum numeric field |
| `count(arr, field)` | `count(data, 'status')` | Count by field value |
| `table(arr, maxRows)` | `table(data, 20)` | Format as markdown table (default: 10 rows) |
| `poll(fn, opts)` | `poll(() => api.getStatus(), { interval: 2000 })` | Poll until done or max iterations |
| `waitFor(fn, opts)` | `waitFor(() => api.isReady())` | Wait for condition to be truthy |

### Polling Helpers

For operations that need to wait for a condition:

```javascript
// Poll an API every 2 seconds, max 5 times
const results = await poll(
  async (i) => {
    const status = await api.getJobStatus(jobId);
    if (status.complete) return { done: true, value: status };
    return status;
  },
  { interval: 2000, maxIterations: 5 }
);

// Wait for a condition (default: 500ms interval, 10s timeout)
const ready = await waitFor(
  async () => {
    const status = await api.getStatus();
    return status.ready ? status : null;
  },
  { interval: 1000, timeout: 30000 }
);
```

### Console Methods

All console methods are captured and returned in the response:

```javascript
console.log('Debug info');     // [LOG] Debug info
console.warn('Warning');       // [WARN] Warning
console.error('Error');        // [ERROR] Error
console.info('Info');          // [INFO] Info
```

### Adapter Access

Adapters are available both via the `adapters` object and as top-level globals:

```javascript
// Both work identically
await adapters.crm.getLeads({ limit: 10 });
await crm.getLeads({ limit: 10 });

// Kebab-case adapters also available as camelCase
await chromeDevtools.listPages();  // chrome-devtools → chromeDevtools
```

### Silent Method Auto-Correction

MCX automatically corrects method names when close enough (Levenshtein distance ≤ 2):

```javascript
// These all work - auto-corrected silently:
supabase.executeSql()      // → supabase.execute_sql()
supabase.listProjects()    // → supabase.list_projects()
supabase.getProject()      // → supabase.get_project()
```

Only truly unknown methods throw errors with suggestions:

```javascript
supabase.unknownMethod()
// Error: supabase.unknownMethod is not a function. Available: list_organizations, get_organization...
```

### Default Parameter Values

Parameters with `default` values in the adapter definition don't need to be provided:

```javascript
// read_only has default: true, so this works:
supabase.execute_sql({ query: "SELECT * FROM users" })
// Equivalent to:
supabase.execute_sql({ query: "SELECT * FROM users", read_only: true })
```

## Advanced Tool Use

MCX implements patterns from [Anthropic's Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use) for better LLM tool discovery.

### Parameter Examples

Parameters can include `example` values to help LLMs understand expected formats:

```typescript
// In adapter definition
parameters: {
  project_id: {
    type: 'string',
    description: 'Project UUID',
    example: 'proj_abc123'  // Helps LLM provide valid input
  }
}
```

### Domain Hints

Adapters are grouped by domain for better discoverability:

```
[payments] stripe(12)
[database] supabase(24), postgres(8)
[email] sendgrid(8)
[devtools] chrome-devtools(25), github(15)
```

Domains are inferred from adapter names/descriptions or can be set explicitly:

```typescript
export const myAdapter = defineAdapter({
  name: 'my-service',
  domain: 'payments',  // Explicit domain
  // ...
});
```

### Lazy Loading

Adapters in `~/.mcx/adapters/` are lazy-loaded for fast startup:

1. **Startup**: Only metadata extracted (name, description, method names)
2. **First call**: Full adapter loaded on demand
3. **Subsequent calls**: Use cached adapter

This enables large adapter collections without impacting startup time.

```typescript
// Adapter metadata extracted at startup (fast regex parsing)
{ name: 'stripe', description: 'Stripe API', methods: ['createCustomer', 'listCharges', ...] }

// Full adapter loaded only when methods are called
mcx_execute({ code: "stripe.createCustomer({ email: 'test@example.com' })" })
```

### mcx_doctor

Run diagnostics to verify MCX installation health:

```typescript
mcx_doctor()
// Returns:
// [x] Bun runtime: v1.3.9
// [x] SQLite/FTS5: 15 sources indexed
// [x] Adapters: 6 loaded
// [x] Sandbox: Execution OK
// [x] FFF: Initialized
// [x] Version: v0.3.12
// 6/6 checks passed
```

Checks performed:
- **Bun runtime**: Version detection
- **SQLite/FTS5**: FTS5 extension availability and indexed sources count
- **Adapters**: Number of loaded adapters
- **Sandbox**: Executes `1 + 1` to verify worker isolation
- **FFF**: Fast File Finder initialization status
- **Version**: Current MCX version

### mcx_upgrade

Get the command to upgrade MCX to the latest version:

```typescript
mcx_upgrade()
// Returns: "bun add -g @papicandela/mcx-cli@latest"
```

The returned command can be executed by the user to upgrade their MCX installation.

### mcx_tree

Navigate large JSON results without loading full content:

```typescript
mcx_tree({ path: "$result" })
// Tree: $result
// ──────────────
// object (5 keys)
//   keys: data, meta, pagination, errors, warnings

mcx_tree({ path: "$result.data", depth: 2 })
// Tree: $result.data
// ──────────────────
// array (100 items)
//   [0]:
//     object (3 keys)
//       id:
//         string (36 chars): "abc-123-..."
//       name:
//         string (12 chars): "Project One"
//       status:
//         string: "active"
//   [1]:
//     object (3 keys)
//       ...
//   ... +97 more
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | string | required | Path to explore (e.g. `$result.data[0].items`) |
| `depth` | number | `1` | Depth to show (deeper = more detail) |

Useful for exploring large execution results stored in variables.

### mcx_spawn

Run code in background, returns immediately with task ID:

```typescript
mcx_spawn({ code: "await slowApi.processLargeDataset()" })
// Started task_1. Check with mcx_tasks, result in $task_1

mcx_spawn({ code: "await poll(...)", label: "sync-job" })
// Started sync-job. Check with mcx_tasks, result in $sync-job
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `code` | string | Code to run in background |
| `label` | string | Optional custom task ID |

Results are stored in `$taskId` when complete.

### mcx_tasks

List or check background tasks:

```typescript
mcx_tasks()
// Background Tasks
// ────────────────
// ⏳ task_1: running (5s...)
// ✓ task_2: completed (2.3s)
// ✗ task_3: failed (0.5s)

mcx_tasks({ id: "task_1" })
// Task: task_1
// Status: completed
// Duration: 5.2s
// Result in: $task_1

mcx_tasks({ status: "running" })
// Only show running tasks
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | - | Get specific task details |
| `status` | string | `"all"` | Filter: `all`, `running`, `completed`, `failed` |
