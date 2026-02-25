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

MCX exposes three tools to the AI agent:

| Tool | Description |
|------|-------------|
| `mcx_execute` | Execute JavaScript/TypeScript code in sandbox with adapter access |
| `mcx_run_skill` | Run a named skill with optional inputs |
| `mcx_list` | List available adapters and skills (read-only) |

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
