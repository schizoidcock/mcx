# Supabase Adapter for MCX

Manage Supabase projects, databases, edge functions, and more directly from Claude.

Based on [supabase-community/supabase-mcp](https://github.com/supabase-community/supabase-mcp).

## Setup

1. Get your Supabase access token from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)

2. Add to `~/.mcx/.env`:
```bash
SUPABASE_ACCESS_TOKEN=sbp_xxxxxxxxxxxxxxxxxxxxx
```

## Tools

### Account & Projects

| Tool | Description |
|------|-------------|
| `list_organizations` | List all organizations |
| `get_organization` | Get organization details |
| `list_projects` | List all projects |
| `get_project` | Get project details |
| `create_project` | Create a new project |
| `pause_project` | Pause a project |
| `restore_project` | Restore a paused project |

### Database

| Tool | Description |
|------|-------------|
| `execute_sql` | Execute SQL query (read-only by default) |
| `list_tables` | List tables in schemas |
| `list_migrations` | List database migrations |
| `apply_migration` | Apply a database migration |

### Debugging

| Tool | Description |
|------|-------------|
| `get_logs` | Get service logs (api, postgres, edge, auth, storage, realtime) |
| `get_advisors` | Get security or performance advisors |

### Development

| Tool | Description |
|------|-------------|
| `get_project_url` | Get project API URL |
| `get_api_keys` | Get project API keys (anon/publishable) |
| `generate_types` | Generate TypeScript types from schema |

### Edge Functions

| Tool | Description |
|------|-------------|
| `list_edge_functions` | List edge functions |
| `get_edge_function` | Get edge function details |

### Branching

| Tool | Description |
|------|-------------|
| `list_branches` | List database branches |
| `create_branch` | Create a database branch |
| `delete_branch` | Delete a branch |
| `merge_branch` | Merge branch to production |

### Storage

| Tool | Description |
|------|-------------|
| `list_storage_buckets` | List storage buckets |
| `get_storage_config` | Get storage config |

## Examples

```typescript
// List all projects
await supabase.list_projects()

// Execute SQL query
await supabase.execute_sql({
  project_id: "abc123",
  query: "SELECT * FROM users LIMIT 10"
})

// Create a migration
await supabase.apply_migration({
  project_id: "abc123",
  name: "add_posts_table",
  query: `
    CREATE TABLE posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `
})

// Get logs
await supabase.get_logs({
  project_id: "abc123",
  service: "postgres"
})

// Generate TypeScript types
await supabase.generate_types({ project_id: "abc123" })
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_ACCESS_TOKEN` | Yes | Personal access token from Supabase dashboard |
| `SUPABASE_API_URL` | No | API URL (default: `https://api.supabase.com`) |
