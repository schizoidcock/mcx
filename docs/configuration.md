# Configuration

## mcx.config.ts

```typescript
import { defineConfig } from '@papicandela/mcx-core';
import { myAdapter } from './adapters/my-adapter';

export default defineConfig({
  // Adapters to load
  adapters: [myAdapter],

  // Skills to load (optional, auto-discovered from skills/)
  skills: [],

  // Sandbox configuration
  sandbox: {
    timeout: 5000,        // Execution timeout (ms)
    memoryLimit: 128,     // Memory limit (MB)
    allowAsync: true,     // Allow async/await
    globals: {},          // Custom globals
    networkPolicy: { mode: 'blocked' },  // Network access policy
    analysis: {
      enabled: true,
      blockOnError: true,
      rules: {
        'no-infinite-loop': 'error',
        'no-nested-loops': 'warn',
      },
    },
  },

  // Environment variables to inject (available in adapters)
  env: {
    API_KEY: process.env.API_KEY,
  },
});
```

## Fluent Config Builder

```typescript
import { configBuilder } from '@papicandela/mcx-core';

export default configBuilder()
  .adapter(myAdapter)
  .adapters(otherAdapter1, otherAdapter2)
  .sandbox({ timeout: 10000 })
  .build();
```

## Directory Structure

```
~/.mcx/
├── mcx.config.ts       # Auto-loads all adapters
├── adapters/
│   ├── stripe.ts
│   ├── slack.ts
│   └── myapi.ts
├── skills/
│   └── daily-summary.ts
├── .env                # All API credentials
└── package.json        # Dependencies
```

## Usage Models

### Global Directory (Default)

MCX uses a single global directory for all adapters and configuration.

**Benefits:**
- One place for all adapters - always available
- One `.env` file for all credentials
- No per-project configuration needed
- Claude Code config never changes

### Per-Project (Legacy)

For isolated project setups, use the `-c` flag:

```bash
mcx serve -c /path/to/project
```

**When to use:**
- Team environments with different API access
- Isolating adapters per project for security
- Different sandbox configurations per project
