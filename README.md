# MCX - Modular Code Execution

```
███╗   ███╗ ██████╗██╗  ██╗
████╗ ████║██╔════╝╚██╗██╔╝
██╔████╔██║██║      ╚███╔╝
██║╚██╔╝██║██║      ██╔██╗
██║ ╚═╝ ██║╚██████╗██╔╝ ██╗
╚═╝     ╚═╝ ╚═════╝╚═╝  ╚═╝
```

MCP server that lets AI agents execute code instead of calling tools directly.

Based on [Anthropic's code execution article](https://www.anthropic.com/engineering/code-execution-with-mcp).

## The Problem

Traditional MCP has two inefficiencies:

1. **Tool definition overload** - Loading all tool definitions floods context. Thousands of tools = hundreds of thousands of tokens before any work begins.

2. **Intermediate result bloat** - Every API response passes through the model. A list of 100 records with nested data can consume 50,000+ tokens.

## The Solution

Instead of calling tools directly, the agent **writes code** that runs in a sandbox:

```javascript
// Agent writes this code, MCX executes it
const invoices = await api.getInvoices({ limit: 100 });
return {
  count: invoices.length,
  total: sum(invoices, 'amount'),
  byStatus: count(invoices, 'status')
};
// Returns ~50 tokens instead of 50,000
```

**Result: 98% token reduction** by filtering data inside the execution environment.

## Key Benefits

| Benefit | Description |
|---------|-------------|
| **Progressive Disclosure** | Adapters loaded on demand, not upfront. Agent only sees what it needs. |
| **Context Efficiency** | Filtering, aggregation, and transformation happen in sandbox. Model sees results, not raw data. |
| **Control Flow** | Loops, conditionals, retries run as native code - no back-and-forth with model. |
| **Privacy** | Intermediate data stays in sandbox. Model only sees what code explicitly returns. |
| **Skills** | Save reusable operations as skills that combine multiple adapter calls. |

## Installation

### Global Install (Recommended)

```bash
# Install the CLI globally
npm install -g @papicandela/mcx-cli

# Or with bun
bun add -g @papicandela/mcx-cli
```

> **Requires Bun:** MCX uses Bun for runtime. [Install Bun](https://bun.sh) if you haven't already.

### From Source (Development)

```bash
git clone https://github.com/schizoidcock/mcx
cd mcx
bun install
bun run build
```

## Quick Start

### New Project Setup

```bash
# 1. Create and enter your project directory
mkdir my-project && cd my-project

# 2. Initialize MCX (creates config, installs dependencies)
mcx init

# 3. Generate adapters from API docs
mcx gen

# 4. Configure MCP (see Claude Code Integration below)
```

### Development Setup (from source)

```bash
# Create environment file
cp .env.template .env

# Create config file
cp mcx.config.template.ts mcx.config.ts

# Generate or create adapters
mcx gen
# or: cp adapters/adapter.template.ts adapters/my-api.ts
```

### Run

```bash
# Start MCP server (stdio mode for Claude Code)
mcx serve

# Or just run mcx (serve is the default command)
mcx
```

### Templates

| File | Description |
|------|-------------|
| `.env.template` | Environment variables (API keys, etc.) |
| `mcx.config.template.ts` | MCX configuration (adapters, sandbox settings) |
| `adapters/adapter.template.ts` | Adapter template with CRUD examples |
| `skills/skill.template.ts` | Skill template with 3 patterns |

## CLI Commands

### `mcx serve`

Start the MCP server. This is the default command when running `mcx` without arguments.

```bash
mcx serve [options]

Options:
  -t, --transport <type>  Transport mode: stdio (default) or http
  -p, --port <number>     HTTP port (default: 3100, only for http)
  -c, --cwd <path>        Working directory for config and adapters
```

**Features:**
- Auto-discovers `mcx.config.ts` by walking up the directory tree
- Loads `.env` files automatically
- HTTP transport binds to `127.0.0.1` only (localhost)
- HTTP mode exposes `/health` endpoint for monitoring

### `mcx gen`

Generate adapters from OpenAPI specs. Run without arguments for interactive TUI mode.

```bash
# Interactive TUI (recommended)
mcx gen

# CLI mode - single file
mcx gen ./api-docs/users.md -n users

# CLI mode - batch directory
mcx gen ./api-docs -n myapi

# Filter specific endpoints
mcx gen ./api-docs -n myapi --include "invoices,payments"
mcx gen ./api-docs -n myapi --exclude "reports,audit"

Options:
  -n, --name <name>          Adapter name (auto-detected from source)
  -o, --output <path>        Output file (default: adapters/<name>.ts)
  -b, --base-url <url>       API base URL (auto-detected from OpenAPI)
  -a, --auth <type>          Auth type: basic, bearer, apikey, none
  --read-only                Generate GET methods only
  --include <patterns>       Include only matching endpoints (comma-separated)
  --exclude <patterns>       Exclude matching endpoints (comma-separated)
```

**Filtering:** Patterns match against category (folder name) or method name. Case-insensitive partial matching.

### `mcx init`

Initialize a new MCX project in the current directory.

```bash
mcx init
```

Creates/updates:
- `package.json` - With MCX dependencies (`@papicandela/mcx-core`, `@papicandela/mcx-adapters`)
- `mcx.config.ts` - Configuration file
- `adapters/example.ts` - Example adapter
- `skills/hello.ts` - Example skill

Automatically runs `bun install` to install dependencies.

### `mcx update`

Update MCX CLI and project dependencies. Alias: `mcx upgrade`

```bash
# Check versions without updating
mcx update --check

# Update everything (CLI + project)
mcx update

# Update CLI only
mcx update --cli

# Update project dependencies only
mcx update --project
```

### `mcx list`

List all available adapters and skills. Alias: `mcx ls`

```bash
mcx list
mcx ls
```

### `mcx run`

Run a skill or script directly.

```bash
# Run a skill by name
mcx run daily-summary date=2024-01-15

# Run a script file
mcx run ./scripts/migrate.ts
```

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

## Usage Patterns

### Bad: Raw API response floods context

```javascript
return await api.getRecords({ limit: 100 });
// 100 objects × 500 tokens each = 50,000 tokens
```

### Good: Filter before returning

```javascript
const data = await api.getRecords({ limit: 100 });
return pick(data, ['id', 'name', 'status']);
// 100 objects × 3 fields = ~500 tokens
```

### Good: Return summary only

```javascript
const data = await api.getRecords({ limit: 100 });
return {
  count: data.length,
  total: sum(data, 'amount'),
  byStatus: count(data, 'status')
};
// ~50 tokens
```

### Good: Debug with logs, return minimal

```javascript
const data = await api.getRecords({ limit: 10 });
console.log(table(pick(data, ['id', 'name', 'amount'])));
return { count: data.length };
// Logs show table, return is tiny
```

### Polling Loop (native control flow)

```javascript
let found = false;
while (!found) {
  const messages = await slack.getChannelHistory({ channel: 'C123' });
  found = messages.some(m => m.text.includes('deployment complete'));
  if (!found) await new Promise(r => setTimeout(r, 5000));
}
return { status: 'deployment complete' };
// Runs entirely in sandbox, no model round-trips
```

## Generating Adapters

Auto-generate adapters from OpenAPI specs in markdown files.

### Interactive TUI

```bash
mcx gen
```

The TUI wizard guides you through:
1. **Source selection** - Single file or batch directory with file browser
2. **Analysis summary** - Shows endpoints, categories, detected auth
3. **Adapter name** - Auto-suggested from API name
4. **Output path** - File browser for destination
5. **Auth/Base URL** - Only asked if not auto-detected
6. **Config import** - Option to add adapter to `mcx.config.ts`

### Auto-Detection

MCX automatically detects:

- **Base URL** from OpenAPI `servers` field
- **Authentication** from OpenAPI `securitySchemes`:
  - `http/basic` → Basic Auth
  - `http/bearer` → Bearer Token
  - `apiKey` → API Key (header or query)
- **SDK-based APIs** from code examples in markdown (TypeScript and Python)

### Batch Processing

Process entire directories of API docs:

```bash
mcx gen ./alegra-endpoints -n alegra
# Scans all .md files, extracts OpenAPI specs, generates single adapter
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

## Creating Skills

Skills are reusable operations that combine multiple adapter calls.

### Using defineSkill

```typescript
import { defineSkill } from '@papicandela/mcx-core';

export const dailySummary = defineSkill({
  name: 'daily-summary',
  description: 'Summarize daily activity across systems',
  adapters: ['crm', 'analytics'],
  code: `
    const leads = await crm.getLeads({ date: inputs.date });
    const visits = await analytics.getPageViews({ date: inputs.date });
    return {
      date: inputs.date,
      leads: leads.length,
      visits: sum(visits, 'count'),
      conversion: (leads.length / sum(visits, 'count') * 100).toFixed(2) + '%'
    };
  `,
  sandbox: {
    timeout: 10000,
    memoryLimit: 128,
  },
});
```

### Using skillBuilder (Fluent API)

```typescript
import { skillBuilder } from '@papicandela/mcx-core';

export const processData = skillBuilder('process-data')
  .description('Fetch, transform, and store data')
  .requires('api', 'db')
  .timeout(15000)
  .memoryLimit(256)
  .code(`
    const raw = await api.fetchRecords({ limit: 1000 });
    const filtered = pick(raw, ['id', 'name', 'amount']);
    const result = await db.bulkInsert(filtered);
    return { inserted: result.count };
  `)
  .build();
```

### Native Function Skills

For complex logic, use a native TypeScript function instead of code string:

```typescript
export const complexSkill = defineSkill({
  name: 'complex-operation',
  description: 'Skill with native TypeScript logic',
  adapters: ['api'],
  run: async ({ adapters, inputs }) => {
    const data = await adapters.api.getData(inputs);

    // Complex processing with full TypeScript support
    const processed = data
      .filter(item => item.active)
      .map(item => ({
        ...item,
        score: calculateScore(item),
      }))
      .sort((a, b) => b.score - a.score);

    return { top10: processed.slice(0, 10) };
  },
});
```

### Skill Directory Structure

Skills can be single files or directories:

```
skills/
├── daily-summary.ts           # Single file skill
├── complex-workflow/          # Directory skill
│   ├── index.ts               # Entry point (required)
│   └── helpers.ts             # Supporting modules
```

## Configuration

### mcx.config.ts

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
  },

  // Environment variables to inject (available in adapters)
  env: {
    API_KEY: process.env.API_KEY,
  },
});
```

### Fluent Config Builder

```typescript
import { configBuilder } from '@papicandela/mcx-core';

export default configBuilder()
  .adapter(myAdapter)
  .adapters(otherAdapter1, otherAdapter2)
  .sandbox({ timeout: 10000 })
  .build();
```

## Programmatic API

Use MCX programmatically in your own applications:

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

### MCXExecutor Methods

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

## Usage Models

MCX supports two deployment models depending on your needs:

### Model A: Centralized (Recommended for personal use)

All adapters and skills live in a single MCX installation:

```
D:\Claude\mcx\           ← MCX installed here
├── mcx.config.ts
├── adapters/
│   ├── crm.ts
│   ├── analytics.ts     ← add adapters here
│   └── ...
└── skills/
    └── daily-summary.ts
```

The MCP server points to this directory. All your adapters are available in every conversation.

**When to use:**
- Personal setup with multiple APIs
- You want all adapters always available
- Simple configuration, no per-project setup needed

### Model B: Per-project

Each project has its own MCX configuration with isolated adapters:

```
D:\Claude\mcx\           ← MCX installed (just the runtime)

D:\ProjectA\             ← Project A
├── mcx.config.ts        ← created by `mcx init`
├── adapters/
│   └── project-a-api.ts
└── skills/

D:\ProjectB\             ← Project B
├── mcx.config.ts
├── adapters/
│   └── project-b-api.ts
└── skills/
```

Each project has its own adapters. The MCP server must point to the specific project directory.

**When to use:**
- Team environments where projects need different APIs
- Distributing MCX as a project dependency
- Isolating adapters per project for security or organization
- Different sandbox configurations per project

**Setup:**
```bash
cd /path/to/your/project
mcx init  # Creates mcx.config.ts, adapters/, skills/
```

Then update your MCP configuration to point to the project:

```json
{
  "mcpServers": {
    "mcx": {
      "command": "mcx",
      "args": ["serve", "-c", "/path/to/your/project"]
    }
  }
}
```

## Claude Code Integration

Add to your Claude Code settings or project's `.mcp.json`:

```json
{
  "mcpServers": {
    "mcx": {
      "command": "mcx",
      "args": ["serve", "-c", "/path/to/project"]
    }
  }
}
```

> **Note:** The `-c` flag is required when using the globally installed CLI to specify which project's config to load.

Or with environment variables:

```json
{
  "mcpServers": {
    "mcx": {
      "command": "mcx",
      "args": ["serve", "-c", "/path/to/project"],
      "env": {
        "API_KEY": "your-api-key"
      }
    }
  }
}
```

## Server Options

```bash
# Default: stdio transport (for Claude Code)
mcx serve

# HTTP transport (for testing, other MCP clients, custom integrations)
mcx serve -t http -p 3100

# Specify working directory
mcx serve -c /path/to/project
```

| Option | Description |
|--------|-------------|
| `-t, --transport` | `stdio` (default) or `http` |
| `-p, --port` | HTTP port (default: 3100, only for http transport) |
| `-c, --cwd` | Working directory for config and adapters |

### HTTP Transport

When using HTTP transport:
- Server binds to `127.0.0.1` only (localhost, for security)
- MCP endpoint: `POST /mcp`
- Health check: `GET /health` returns `{ status, server, version }`

### Result Summarization

Large results are automatically summarized to prevent context overflow:
- Arrays truncated to 5 items with `"... and N more"` indicator
- Nested arrays limited to 3 items
- Objects with >5 keys are summarized

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

## License

MIT
