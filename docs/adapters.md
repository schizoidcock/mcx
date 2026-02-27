# Adapters

Adapters bridge the sandbox to external APIs and services.

## Creating Adapters

```typescript
import { defineAdapter } from '@papicandela/mcx-adapters';

export const myApi = defineAdapter({
  name: 'myapi',
  description: 'My API adapter',
  tools: {
    getRecords: {
      description: 'Fetch records',
      parameters: {
        limit: { type: 'number', description: 'Max results' },
      },
      execute: async (params) => {
        const res = await fetch(`${BASE_URL}/records?limit=${params.limit}`);
        return res.json();
      },
    },
  },
});
```

## Generating Adapters

Auto-generate adapters from OpenAPI specs in markdown files.

### From OpenAPI

```bash
# Interactive TUI (recommended)
mcx gen

# CLI mode
mcx gen ./api-docs/users.md -n users
mcx gen ./api-docs -n myapi  # Batch process directory
```

### SDK-Based Adapters

When MCX detects SDK usage in docs, it generates SDK wrappers instead of fetch-based code:

```typescript
// Generated from SDK-based API docs
import { ZepClient } from '@getzep/zep-cloud';

const client = new ZepClient({ apiKey: process.env.ZEP_API_KEY });

export const zep = defineAdapter({
  tools: {
    addMemory: {
      execute: async (params) => client.memory.add(params.sessionId, params),
    },
  },
});
```

## Built-in Adapters

### Fetch Adapter

Generic HTTP client with all standard methods.

```typescript
import { createFetchAdapter } from '@papicandela/mcx-adapters';

const api = createFetchAdapter({
  baseUrl: 'https://api.example.com',
  headers: { 'X-API-Key': process.env.API_KEY },
  timeout: 30000,
});
```

**Tools:** `get`, `post`, `put`, `patch`, `delete`, `head`, `request`

## Response Truncation

MCX automatically truncates large responses at the MCP level. This is configurable via `mcx_execute` parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `truncate` | `true` | Enable/disable truncation |
| `maxItems` | `10` | Max array items to return |
| `maxStringLength` | `500` | Max string length |

### Examples

```typescript
// Default truncation (10 items, 500 chars)
mcx_execute({ code: "await stripe.listCustomers()" })

// More items
mcx_execute({ code: "await stripe.listCustomers()", maxItems: 50 })

// Full response (no truncation)
mcx_execute({ code: "await stripe.listCustomers()", truncate: false })

// Custom limits
mcx_execute({
  code: "await stripe.listCustomers()",
  maxItems: 100,
  maxStringLength: 2000
})
```

**Note:** Adapters return raw data. Truncation is applied by the MCP server before returning results.

## TypeScript Types for LLM

Adapter types are available via `mcx_search("adapter_name")`. The `mcx_execute` tool description shows a summary of available adapters, and the LLM can query specific adapter APIs on demand.

This approach:
- Keeps `mcx_execute` description compact (no full type declarations)
- Allows LLM to discover adapter APIs as needed
- Prevents context window overflow with large adapter collections
