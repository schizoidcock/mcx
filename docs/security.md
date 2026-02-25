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
| `no-infinite-loop` | error | `while(true)`, `for(;;)` without break |
| `no-nested-loops` | warn | Nested loops (O(n²) complexity) |
| `no-adapter-in-loop` | warn | Adapter calls inside loops (rate limiting risk) |
| `no-unhandled-async` | warn | `async` in `forEach`/`map` without `Promise.all` |
| `no-dangerous-globals` | warn | `eval`, `require`, `process` usage |

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
