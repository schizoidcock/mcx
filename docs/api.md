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

MCX exposes eight tools to the AI agent:

| Tool | Description |
|------|-------------|
| `mcx_execute` | Execute code in sandbox, auto-stores result as `$result` |
| `mcx_search` | 3 modes: spec exploration, FTS5 search, adapter/method search |
| `mcx_batch` | Multiple executions/searches in one call (bypasses throttling) |
| `mcx_file` | Process local files with `$file` variable injection |
| `mcx_fetch` | Fetch URLs with HTML-to-markdown and auto-indexing |
| `mcx_list` | List available adapters and skills |
| `mcx_stats` | Session statistics (indexed content, variables) |
| `mcx_run_skill` | Run a named skill with optional inputs |

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

Process local files with `$file` variable injection:

```typescript
mcx_file({
  path: "package.json",
  code: "({ name: $file.name, deps: Object.keys($file.dependencies) })"
})
// $file is parsed JSON for .json files, { text, lines } for others
```

### mcx_fetch

Fetch URLs with automatic HTML-to-markdown conversion:

```typescript
mcx_fetch({
  url: "https://docs.example.com/api",
  code: "$content.split('## ').length"  // $content is markdown
})
```

## Built-in Helpers

Functions available in the sandbox for efficient data handling:

| Helper | Usage | Description |
|--------|-------|-------------|
| `pick(arr, fields)` | `pick(data, ['id', 'name'])` | Extract specific fields (supports dot-notation: `'address.city'`) |
| `first(arr, n)` | `first(data, 5)` | First N items (default: 5) |
| `sum(arr, field)` | `sum(data, 'amount')` | Sum numeric field |
| `count(arr, field)` | `count(data, 'status')` | Count by field value |
| `table(arr, maxRows)` | `table(data, 20)` | Format as markdown table (default: 10 rows) |

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

### Fuzzy Method Suggestions

When calling an undefined method, MCX suggests similar methods:

```javascript
supabase.executeSql()
// Error: supabase.executeSql is not a function. Did you mean: execute_sql?

supabase.listProjects()
// Error: supabase.listProjects is not a function. Did you mean: list_projects?

supabase.unknownMethod()
// Error: supabase.unknownMethod is not a function. Available: list_organizations, get_organization...
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
