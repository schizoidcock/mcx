# Sandbox Security

MCX includes multiple layers of security for safe code execution.

## Security Layers

1. **Worker Isolation** - Code runs in separate JavaScript context with no access to main thread's scope
2. **Network Isolation** - fetch/WebSocket blocked by default (configurable)
3. **Pre-execution Analysis** - Detects infinite loops, dangerous patterns before execution
4. **Code Normalization** - AST-based validation and auto-return
5. **Timeout** - Configurable execution timeout (default 5s)

## Network Isolation

By default, all network access is blocked in the sandbox:

```typescript
// In sandbox - blocked by default
await fetch('https://external-api.com'); // Error: Network access blocked

// Adapters work because they run outside the sandbox
await adapters.api.getData(); // OK - goes through adapter bridge
```

Configure network policy in `mcx.config.ts`:

```typescript
export default defineConfig({
  sandbox: {
    networkPolicy: { mode: 'blocked' },  // Default - no network
    // networkPolicy: { mode: 'allowed', domains: ['api.example.com'] },
    // networkPolicy: { mode: 'unrestricted' },  // Allow all (not recommended)
  },
});
```

## Pre-execution Analysis

MCX analyzes code before execution to detect potential issues:

| Rule | Severity | Detects |
|------|----------|---------|
| `no-infinite-loop` | error | `while(true)`, `for(;;)`, `do...while(true)` without break/return/throw |
| `no-nested-loops` | warn | Nested loops (O(n²) complexity) |
| `no-adapter-in-loop` | warn | Adapter calls inside loops (rate limiting risk) |
| `no-unhandled-async` | warn | `async` in `forEach`/`map` without `Promise.all` |
| `no-dangerous-globals` | error/warn | `eval`, `Function`, `AsyncFunction` constructor (error), `process` (warn) |

**Errors block execution**, warnings are logged but execution continues.

Configure analysis in `mcx.config.ts`:

```typescript
export default defineConfig({
  sandbox: {
    analysis: {
      enabled: true,        // Default
      blockOnError: true,   // Block on errors (default)
      rules: {
        'no-infinite-loop': 'error',   // Default
        'no-nested-loops': 'warn',     // Default
        'no-adapter-in-loop': 'off',   // Disable this rule
      },
    },
  },
});
```

## Code Normalization

LLM-generated code is automatically normalized:

- Auto-adds `return` to expressions: `42` → `return 42`
- Handles multiple statements: `const x = 1; x + 1` → `const x = 1; return x + 1`
- Validates syntax before execution

## Architecture

```
┌──────────┐      ┌───────────────────────────────────┐
│  Claude  │ ───▶ │            MCX Server             │
│   /LLM   │ code │  ┌─────────┐ ┌─────────────────┐  │
└──────────┘      │  │ Sandbox │ │    Adapters     │  │
                  │  │  (Bun   │ │ api.getRecords()│  │
      ◀───────────│  │ Worker) │ │ api.createItem()│  │
     result       │  └─────────┘ └─────────────────┘  │
    (filtered)    │       │                           │
                  │       ▼                           │
                  │  ┌─────────────────────────────┐  │
                  │  │ Helpers: pick/sum/count/... │  │
                  │  └─────────────────────────────┘  │
                  └───────────────────────────────────┘
```

## Additional Security Hardening

### Path Traversal Protection

The `mcx gen` command validates output paths to prevent writing files outside allowed directories:

- Only `cwd` and `~/.mcx/` are allowed as output locations
- Symlinks are resolved to prevent bypass attacks
- Prefix collision attacks are blocked (e.g., `~/.mcx-malicious` won't match `~/.mcx`)

### Environment Variable Protection

Dangerous environment variables are blocked from `.env` files and `config.env`:

```
NODE_OPTIONS, NODE_PATH, LD_PRELOAD, PATH, SHELL, BASH_ENV, ...
```

This prevents privilege escalation and code injection via environment manipulation.

### Code Generation Security

Generated adapter code is protected against injection attacks:

- All strings are properly escaped for their context (single quotes, template literals)
- Identifier names are validated before use in generated code
- Package names are validated against npm naming rules

### Response Size Limits

MCP responses are limited to prevent memory exhaustion:

- Character limit: 25,000 chars per response (configurable via truncation params)
- HTTP body limit: 100KB max response body
- Array truncation: Default 10 items (configurable up to 1000)

## Runtime

MCX is **100% Bun-native**:

- **Sandbox:** Bun Workers (native JavaScript isolation)
- **HTTP:** Bun.serve (no Express)
- **Files:** Bun.file/Bun.Glob (no node:fs, no glob)
- **Env:** Automatic .env loading (no dotenv)

Benefits:
- Faster startup (~100ms)
- Smaller bundle (~0.5MB vs 1.5MB)
- No native module compilation issues
- Single runtime (no Node.js required)
