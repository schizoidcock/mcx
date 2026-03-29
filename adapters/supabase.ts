/**
 * Supabase Management API Adapter for MCX
 * Based on: https://github.com/supabase-community/supabase-mcp
 */
import { defineAdapter } from "@papicandela/mcx-adapters";

const API_URL = process.env.SUPABASE_API_URL || "https://api.supabase.com";

// Track currently selected project (auto-set on create_project, select_project)
let currentProjectId: string | null = null;

/**
 * Resolve project_id - use provided, current, or throw helpful error
 */
async function resolveProjectId(provided?: string): Promise<string> {
  if (provided) {
    currentProjectId = provided;
    return provided;
  }
  if (currentProjectId) {
    return currentProjectId;
  }
  throw new Error("No project selected. Use list_projects() then select_project({ project_id }) or pass project_id directly.");
}

async function request<T>(path: string, options: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN required");

  let url = `${API_URL}${path}`;
  if (options.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined) params.append(k, String(v));
    }
    if (params.toString()) url += `?${params}`;
  }

  const res = await fetch(url, {
    method: options.method || "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase API (${res.status}): ${err}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : ({} as T);
}

export default defineAdapter({
  name: "supabase",
  description: "Supabase Management API",

  tools: {
    // Account
    list_organizations: {
      description: "List all organizations",
      parameters: {},
      async execute() {
        return request("/v1/organizations");
      },
    },
    get_organization: {
      description: "Get organization details",
      parameters: { id: { type: "string", description: "Organization ID" } },
      async execute({ id }: { id: string }) {
        return request(`/v1/organizations/${id}`);
      },
    },
    list_projects: {
      description: "List all projects",
      parameters: {},
      async execute() {
        return request("/v1/projects");
      },
    },
    get_project: {
      description: "Get project details. Auto-selects current project if not provided.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}`);
      },
    },
    select_project: {
      description: "Select a project for subsequent commands (from list_projects)",
      parameters: { project_id: { type: "string", description: "Project ID to select" } },
      async execute({ project_id }: { project_id: string }) {
        currentProjectId = project_id;
        const project = await request<{ name: string; region: string }>(`/v1/projects/${project_id}`);
        return { success: true, selected: project_id, name: project.name, region: project.region };
      },
    },
    create_project: {
      description: "Create a new project (auto-selected for subsequent calls)",
      parameters: {
        name: { type: "string", description: "Project name" },
        organization_id: { type: "string", description: "Organization ID" },
        region: { type: "string", description: "Region (e.g. us-east-1)" },
      },
      async execute({ name, organization_id, region }: { name: string; organization_id: string; region: string }) {
        const result = await request<{ id: string }>("/v1/projects", { method: "POST", body: { name, organization_id, region, db_pass: crypto.randomUUID() } });
        currentProjectId = result.id; // Auto-select new project
        return result;
      },
    },
    pause_project: {
      description: "Pause a project. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        await request(`/v1/projects/${id}/pause`, { method: "POST" });
        return { success: true };
      },
    },
    restore_project: {
      description: "Restore a paused project. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        await request(`/v1/projects/${id}/restore`, { method: "POST" });
        return { success: true };
      },
    },

    // Database
    execute_sql: {
      description: "Execute SQL query. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        query: { type: "string", description: "SQL query" },
        read_only: { type: "boolean", description: "Read-only mode", default: true },
      },
      async execute({ project_id, query, read_only = true }: { project_id?: string; query: string; read_only?: boolean }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/database/query`, { method: "POST", body: { query, read_only } });
      },
    },
    list_tables: {
      description: "List tables in schemas. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        schemas: { type: "string", description: "Comma-separated schemas", default: "public" },
      },
      async execute({ project_id, schemas = "public" }: { project_id?: string; schemas?: string }) {
        const id = await resolveProjectId(project_id);
        const schemaList = schemas.split(",").map(s => `'${s.trim()}'`).join(",");
        const query = `SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN (${schemaList})`;
        return request(`/v1/projects/${id}/database/query`, { method: "POST", body: { query, read_only: true } });
      },
    },
    list_migrations: {
      description: "List database migrations. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/database/migrations`);
      },
    },
    apply_migration: {
      description: "Apply a database migration. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        name: { type: "string", description: "Migration name (snake_case)" },
        query: { type: "string", description: "SQL migration" },
      },
      async execute({ project_id, name, query }: { project_id?: string; name: string; query: string }) {
        const id = await resolveProjectId(project_id);
        await request(`/v1/projects/${id}/database/migrations`, { method: "POST", body: { name, query } });
        return { success: true };
      },
    },

    // Debugging
    get_logs: {
      description: "Get service logs. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        service: { type: "string", description: "Service: api, postgres, edge, auth, storage, realtime" },
      },
      async execute({ project_id, service }: { project_id?: string; service: string }) {
        const id = await resolveProjectId(project_id);
        const sql = `SELECT id, timestamp, event_message FROM edge_logs WHERE service = '${service}' ORDER BY timestamp DESC LIMIT 100`;
        return request(`/v1/projects/${id}/analytics/endpoints/logs.all`, { query: { sql } });
      },
    },
    get_advisors: {
      description: "Get security or performance advisors. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        type: { type: "string", description: "Type: security or performance" },
      },
      async execute({ project_id, type }: { project_id?: string; type: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/advisors/${type}`);
      },
    },

    // Development
    get_project_url: {
      description: "Get project API URL. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return { url: `https://${id}.supabase.co` };
      },
    },
    get_api_keys: {
      description: "Get project API keys. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        const keys = await request<Array<{ api_key: string; name: string; type?: string }>>(`/v1/projects/${id}/api-keys`);
        return keys.filter(k => k.name === "anon" || k.type === "publishable");
      },
    },
    generate_types: {
      description: "Generate TypeScript types from schema. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/types/typescript`);
      },
    },

    // Edge Functions
    list_edge_functions: {
      description: "List edge functions. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/functions`);
      },
    },
    get_edge_function: {
      description: "Get edge function details. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        slug: { type: "string", description: "Function slug" },
      },
      async execute({ project_id, slug }: { project_id?: string; slug: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/functions/${slug}`);
      },
    },

    // Branching
    list_branches: {
      description: "List database branches. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        try {
          return await request(`/v1/projects/${id}/branches`);
        } catch {
          return [];
        }
      },
    },
    create_branch: {
      description: "Create a database branch. Auto-selects current project.",
      parameters: {
        project_id: { type: "string", required: false, description: "Project ID (optional)" },
        name: { type: "string", description: "Branch name" },
      },
      async execute({ project_id, name }: { project_id?: string; name: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/branches`, { method: "POST", body: { branch_name: name } });
      },
    },
    delete_branch: {
      description: "Delete a branch",
      parameters: { branch_id: { type: "string", description: "Branch ID" } },
      async execute({ branch_id }: { branch_id: string }) {
        await request(`/v1/branches/${branch_id}`, { method: "DELETE" });
        return { success: true };
      },
    },
    merge_branch: {
      description: "Merge branch to production",
      parameters: { branch_id: { type: "string", description: "Branch ID" } },
      async execute({ branch_id }: { branch_id: string }) {
        await request(`/v1/branches/${branch_id}/merge`, { method: "POST", body: {} });
        return { success: true };
      },
    },

    // Storage
    list_storage_buckets: {
      description: "List storage buckets. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/storage/buckets`);
      },
    },
    get_storage_config: {
      description: "Get storage config. Auto-selects current project.",
      parameters: { project_id: { type: "string", required: false, description: "Project ID (optional)" } },
      async execute({ project_id }: { project_id?: string }) {
        const id = await resolveProjectId(project_id);
        return request(`/v1/projects/${id}/config/storage`);
      },
    },
  },
});
