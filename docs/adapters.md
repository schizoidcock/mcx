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
        return fetch(`${BASE_URL}/records?limit=${params.limit}`).then(r => r.json());
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

## TypeScript Types for LLM

The `mcx_execute` tool includes TypeScript type declarations for all adapters, helping the LLM write correct code:

```typescript
// Included in mcx_execute tool description:
interface Stripe_ListCustomers_Input {
  /** Maximum number of customers to return */
  limit?: number;
  /** Filter by email */
  email?: string;
}

declare const stripe: {
  /** List all customers */
  listCustomers(params?: Stripe_ListCustomers_Input): Promise<Customer[]>;
  /** Get customer by ID */
  getCustomer(params: { id: string }): Promise<Customer>;
};
```

This allows the LLM to understand:
- Available methods on each adapter
- Parameter types and descriptions
- Return types
