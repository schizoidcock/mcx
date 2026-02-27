# CLI Commands

## `mcx serve`

Start the MCP server. This is the default command when running `mcx` without arguments.

```bash
mcx serve [options]

Options:
  -t, --transport <type>  Transport mode: stdio (default) or http
  -p, --port <number>     HTTP port (default: 3100, only for http)
  -c, --cwd <path>        Override config directory (default: ~/.mcx/)
```

**Features:**
- Uses global `~/.mcx/` directory by default
- Auto-loads all adapters from `~/.mcx/adapters/`
- Loads `.env` from `~/.mcx/.env`
- HTTP transport binds to `127.0.0.1` only (localhost)
- HTTP mode exposes `/health` endpoint for monitoring

### HTTP Transport

When using HTTP transport:
- Server binds to `127.0.0.1` only (localhost, for security)
- MCP endpoint: `POST /mcp`
- Health check: `GET /health` returns `{ status, server, version }`

### Result Truncation

Large results are automatically truncated to prevent context overflow. Configurable via `mcx_execute` parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `truncate` | `true` | Enable/disable truncation |
| `maxItems` | `10` | Max array items to return |
| `maxStringLength` | `500` | Max string length |

Examples:
```typescript
// Default truncation
mcx_execute({ code: "await api.list()" })

// More items
mcx_execute({ code: "await api.list()", maxItems: 50 })

// Full response (no truncation)
mcx_execute({ code: "await api.list()", truncate: false })
```

## `mcx gen`

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
  -o, --output <path>        Output file (default: ~/.mcx/adapters/<name>.ts)
  -b, --base-url <url>       API base URL (auto-detected from OpenAPI)
  -a, --auth <type>          Auth type: basic, bearer, apikey, none
  --read-only                Generate GET methods only
  --include <patterns>       Include only matching endpoints (comma-separated)
  --exclude <patterns>       Exclude matching endpoints (comma-separated)
```

**Filtering:** Patterns match against category (folder name) or method name. Case-insensitive partial matching.

### Interactive TUI

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

## `mcx init`

Initialize the global MCX directory at `~/.mcx/`.

```bash
mcx init
```

Creates:
- `~/.mcx/package.json` - MCX dependencies
- `~/.mcx/mcx.config.ts` - Auto-loading config (discovers all adapters)
- `~/.mcx/adapters/` - Directory for your adapters
- `~/.mcx/skills/hello.ts` - Example skill
- `~/.mcx/.env` - Template for API credentials

Automatically runs `bun install` to install dependencies.

## `mcx update`

Update MCX CLI and global installation. Alias: `mcx upgrade`

```bash
# Check versions without updating
mcx update --check

# Update everything (CLI + global ~/.mcx/)
mcx update

# Update CLI only
mcx update --cli

# Clean and update global installation only
mcx update --global
```

The `--global` flag cleans the `~/.mcx/` installation:
- Removes `node_modules/` and `bun.lockb`
- Regenerates `mcx.config.ts` with latest template
- Updates dependencies to latest versions
- Preserves your `adapters/`, `skills/`, and `.env`

## `mcx list`

List all available adapters and skills. Alias: `mcx ls`

```bash
mcx list
mcx ls
```

## `mcx run`

Run a skill or script directly.

```bash
# Run a skill by name
mcx run daily-summary date=2024-01-15

# Run a script file
mcx run ./scripts/migrate.ts
```
