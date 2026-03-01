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

MCX exposes four tools to the AI agent:

| Tool | Description |
|------|-------------|
| `mcx_execute` | Execute JavaScript/TypeScript code in sandbox with adapter access |
| `mcx_run_skill` | Run a named skill with optional inputs |
| `mcx_list` | List available adapters and skills (read-only) |
| `mcx_search` | Search adapters/methods and get TypeScript API signatures |

### mcx_execute Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `code` | string | required | JavaScript/TypeScript code to execute |
| `truncate` | boolean | `true` | Enable/disable result truncation |
| `maxItems` | number | `10` | Max array items when truncating |
| `maxStringLength` | number | `500` | Max string length when truncating |

### mcx_search

Use `mcx_search` to discover adapter APIs and get exact parameter info:

```typescript
// List all methods in an adapter
mcx_search({ adapter: "stripe" })

// Search methods by partial name (compact output)
mcx_search({ adapter: "stripe", method: "create" })

// Get DETAILED params for exact method match
mcx_search({ adapter: "stripe", method: "createCustomer" })
// → Returns: parameters, types, required, defaults, example

// Search across all adapters
mcx_search({ query: "invoice" })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `adapter` | string | Filter by adapter name (exact or partial) |
| `method` | string | Filter by method name (exact or partial) |
| `query` | string | Search term for names/descriptions |
| `type` | string | Filter: "all", "adapters", "methods", "skills" |
| `limit` | number | Max results per category (default: 20) |

**Token optimization:** Detailed parameter info (types, required, defaults) only appears on exact method name match. Partial matches return compact TypeScript signatures only.

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
```
