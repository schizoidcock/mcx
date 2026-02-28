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
| **Configurable Truncation** | Control result size via `truncate`, `maxItems`, `maxStringLength` |
| **Control Flow** | Loops, conditionals, retries run as native code |
| **Privacy** | Intermediate data stays in sandbox |
| **Skills** | Reusable operations combining multiple adapter calls |
| **Security** | Network isolation, pre-execution analysis, path traversal protection, env injection prevention |

## CLI Commands

| Command | Description |
|---------|-------------|
| `mcx serve` | Start MCP server (default) |
| `mcx gen` | Generate adapters from OpenAPI specs |
| `mcx init` | Initialize global `~/.mcx/` directory |
| `mcx update` | Update CLI and global installation |
| `mcx list` | List available adapters and skills |
| `mcx run` | Run a skill directly |

See [CLI documentation](docs/cli.md) for details.

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
