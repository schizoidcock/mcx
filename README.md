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

1. **Tool definition overload** - Loading all tool definitions floods context
2. **Intermediate result bloat** - Every API response passes through the model

## The Solution

Instead of calling tools directly, the agent **writes code** that runs in a sandbox:

```javascript
const invoices = await api.getInvoices({ limit: 100 });
return {
  count: invoices.length,
  total: sum(invoices, 'amount'),
  byStatus: count(invoices, 'status')
};
// Returns ~50 tokens instead of 50,000
```

**Result: 98% token reduction** by filtering data inside the execution environment.

## Installation

```bash
# Install globally with bun
bun add -g @papicandela/mcx-cli

# Initialize global directory (~/.mcx/)
mcx init
```

> **Requires Bun:** MCX uses Bun for runtime. [Install Bun](https://bun.sh) if you haven't already.

## Quick Start

```bash
# 1. Initialize global MCX directory
mcx init

# 2. Generate adapters from API docs
mcx gen ./api-docs.md -n myapi

# 3. Add credentials to ~/.mcx/.env

# 4. Start server
mcx serve
```

## Directory Structure

```
~/.mcx/
├── adapters/           # All your adapters
│   ├── stripe.ts
│   └── myapi.ts
├── skills/             # Reusable skills
├── mcx.config.ts       # Auto-loads all adapters
├── .env                # API credentials
└── package.json        # Dependencies
```

## Claude Code Integration

Add to your Claude Code settings (`~/.claude.json` or project's `.mcp.json`):

```json
{
  "mcpServers": {
    "mcx": {
      "command": "mcx",
      "args": ["serve"]
    }
  }
}
```

That's it! MCX automatically uses `~/.mcx/` for config and adapters.

## Key Features

| Feature | Description |
|---------|-------------|
| **Progressive Disclosure** | Adapters loaded on demand, not upfront |
| **Context Efficiency** | Filtering happens in sandbox, model sees results only |
| **Variable Persistence** | Store results as `$invoices`, `$customers` for later use |
| **FTS5 Search** | Auto-index large outputs, search with `intent` parameter |
| **Batch Operations** | `mcx_batch` for multiple operations in one call |
| **File Processing** | `mcx_file` to process local files with `$file` injection |
| **URL Fetching** | `mcx_fetch` with HTML-to-markdown conversion |
| **Control Flow** | Loops, conditionals, retries run as native code |
| **Privacy** | Intermediate data stays in sandbox |
| **Security** | Network isolation, path traversal protection, env injection prevention |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mcx_execute` | Execute code with adapter access, auto-stores as `$result` |
| `mcx_search` | 3 modes: spec exploration, FTS5 search, adapter/method search |
| `mcx_batch` | Multiple executions/searches in one call (bypasses throttling) |
| `mcx_file` | Process local files with `$file` variable injection |
| `mcx_fetch` | Fetch URLs with HTML-to-markdown and auto-indexing |
| `mcx_list` | List available adapters and skills |
| `mcx_stats` | Session statistics (indexed content, variables) |
| `mcx_run_skill` | Run a registered skill |

## CLI Commands

| Command | Description |
|---------|-------------|
| `mcx serve` | Start MCP server (default) |
| `mcx gen` | Generate adapters from OpenAPI specs (with TUI) |
| `mcx init` | Initialize global `~/.mcx/` directory |
| `mcx update` | Update CLI and global installation |
| `mcx list` | List available adapters and skills |
| `mcx run` | Run a skill directly |
| `mcx logs` | View server logs |

See [CLI documentation](docs/cli.md) for details.

## Included Adapters

| Adapter | Methods | Description |
|---------|---------|-------------|
| `supabase` | 24 | Supabase Management API (projects, tables, functions, secrets) |
| `chrome-devtools` | 25 | Chrome DevTools Protocol (screenshots, navigation, DOM) |

Generate your own adapters from OpenAPI docs:
```bash
mcx gen ./api-docs.md -n myapi
```

## Built-in Helpers

Functions available in the sandbox:

```javascript
pick(data, ['id', 'name'])     // Extract fields
first(data, 5)                  // First N items
sum(data, 'amount')             // Sum numeric field
count(data, 'status')           // Count by field
table(data, 10)                 // Markdown table
```

## Documentation

- [CLI Commands](docs/cli.md) - Detailed command reference
- [Adapters](docs/adapters.md) - Creating and generating adapters
- [Skills](docs/skills.md) - Reusable operations
- [Configuration](docs/configuration.md) - Config file reference
- [Programmatic API](docs/api.md) - Using MCX in code
- [Security](docs/security.md) - Sandbox security layers

## Development

```bash
git clone https://github.com/schizoidcock/mcx
cd mcx
bun install
bun run build
```

## License

MIT
