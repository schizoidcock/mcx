/**
 * MCX MCP Server
 *
 * Exposes three MCP tools:
 * - mcx_execute: Execute code in sandboxed environment with adapter access
 * - mcx_run_skill: Run a named skill with optional inputs
 * - mcx_list: List available adapters and skills
 *
 * Features:
 * - Auto-loads adapters from ~/.mcx/adapters/
 * - Generates TypeScript types for LLM context
 * - Network isolation, pre-execution analysis, code normalization
 * - Supports stdio and HTTP transports
 */

import { join, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pc from "picocolors";
import { BunWorkerSandbox, generateTypes, generateTypesSummary } from "@papicandela/mcx-core";
import { getMcxCliDir, getMcxHomeDir, ensureMcxHomeDir, findProjectRoot } from "../utils/paths";

// ============================================================================
// .env Loading
// ============================================================================


/**
 * Load environment variables from a .env file
 * Returns the number of variables loaded
 */
async function loadEnvFromPath(envPath: string, label: string): Promise<number> {
  const file = Bun.file(envPath);

  if (!(await file.exists())) {
    return 0;
  }

  try {
    const content = await file.text();
    let loaded = 0;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
      loaded++;
    }

    if (loaded > 0) {
      console.error(pc.dim(`Loaded ${loaded} env var(s) from ${label}`));
    }
    return loaded;
  } catch (error) {
    console.error(pc.yellow(`Warning: Failed to load ${label}: ${error}`));
    return 0;
  }
}

/**
 * Load environment variables from global MCX home directory
 * e.g., ~/.mcx/.env
 */
async function loadEnvFile(): Promise<void> {
  const mcxHome = getMcxHomeDir();
  const envPath = join(mcxHome, ".env");
  await loadEnvFromPath(envPath, "~/.mcx");
}

// ============================================================================
// Types (CLI-specific, compatible with @papicandela/mcx-core)
// ============================================================================

// Note: These types are intentionally local to serve.ts for CLI-specific needs.
// They are compatible with the unified types in @papicandela/mcx-core.
// Future refactor: import base types from core and extend here.

interface Skill {
  name: string;
  description?: string;
  /** CLI-specific: input schema for skills */
  inputs?: Record<string, { type: string; description?: string; default?: unknown }>;
  run: (ctx: { inputs: Record<string, unknown> }) => Promise<unknown>;
}

/** Compatible with @papicandela/mcx-core AdapterTool */
interface AdapterMethod {
  description: string;
  execute: (params: unknown) => Promise<unknown>;
}

/** Compatible with @papicandela/mcx-core Adapter */
interface Adapter {
  name: string;
  description?: string;
  tools: Record<string, AdapterMethod>;
}

/** Compatible with @papicandela/mcx-core MCXConfig */
interface MCXConfig {
  adapters?: Adapter[];
  sandbox?: {
    timeout?: number;
    memoryLimit?: number;
  };
  env?: Record<string, string | undefined>;
}

// ============================================================================
// Zod Schemas
// ============================================================================

const ExecuteInputSchema = z.object({
  code: z.string()
    .min(1, "Code cannot be empty")
    .describe("JavaScript/TypeScript code to execute in the sandbox"),
}).strict();

const RunSkillInputSchema = z.object({
  skill: z.string()
    .min(1, "Skill name is required")
    .describe("The name of the skill to run"),
  inputs: z.record(z.unknown())
    .optional()
    .default({})
    .describe("Input parameters for the skill"),
}).strict();

const ListInputSchema = z.object({}).strict();

const SearchInputSchema = z.object({
  query: z.string()
    .min(1, "Search query is required")
    .describe("Search term to find adapters, methods, or skills (searches names and descriptions)"),
  type: z.enum(["all", "adapters", "methods", "skills"])
    .optional()
    .default("all")
    .describe("Filter results by type"),
}).strict();

type ExecuteInput = z.infer<typeof ExecuteInputSchema>;
type RunSkillInput = z.infer<typeof RunSkillInputSchema>;
type SearchInput = z.infer<typeof SearchInputSchema>;

// ============================================================================
// Result Summarization (per Anthropic's code execution article)
// ============================================================================

const MAX_ARRAY_ITEMS = 5;

interface SummarizedResult {
  value: unknown;
  truncated: boolean;
  originalSize?: string;
}

function summarizeResult(value: unknown): SummarizedResult {
  if (value === undefined || value === null) {
    return { value, truncated: false };
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      return {
        value: value.slice(0, MAX_ARRAY_ITEMS).map(summarizeObject),
        truncated: true,
        originalSize: `${value.length} items, showing first ${MAX_ARRAY_ITEMS}`,
      };
    }
    return { value: value.map(summarizeObject), truncated: false };
  }

  if (typeof value === "object") {
    return { value: summarizeObject(value), truncated: false };
  }

  return { value, truncated: false };
}

function summarizeObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    if (obj.length > MAX_ARRAY_ITEMS) {
      return [...obj.slice(0, 3).map(summarizeObject), `... +${obj.length - 3} more`];
    }
    return obj.map(summarizeObject);
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (Array.isArray(val) && val.length > MAX_ARRAY_ITEMS) {
      result[key] = [...val.slice(0, MAX_ARRAY_ITEMS).map(summarizeObject), `... +${val.length - MAX_ARRAY_ITEMS} more`];
    } else if (typeof val === "object" && val !== null) {
      const keys = Object.keys(val as object);
      if (keys.length > 5) {
        result[key] = { _summary: `{${keys.slice(0, 3).join(", ")}, ... +${keys.length - 3} keys}` };
      } else {
        result[key] = summarizeObject(val);
      }
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ============================================================================
// Config & Skills Loading (using Bun native APIs)
// ============================================================================

async function loadConfig(): Promise<MCXConfig | null> {
  const configPath = join(process.cwd(), "mcx.config.ts");
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return null;
  }

  try {
    console.error(pc.dim(`Loading config: ${configPath}`));
    const configModule = await import(configPath);
    const config = configModule.default || configModule;
    console.error(pc.dim(`Loaded ${config?.adapters?.length || 0} adapter(s)`));

    // Copy config.env to process.env for adapters that read from process.env
    if (config?.env) {
      for (const [key, value] of Object.entries(config.env)) {
        if (value !== undefined && value !== null) {
          process.env[key] = String(value);
        }
      }
      console.error(pc.dim(`Injected ${Object.keys(config.env).length} env var(s)`));
    }

    return config;
  } catch (error) {
    console.error(pc.yellow("Warning: Failed to load mcx.config.ts:"), error);
    return null;
  }
}

async function loadSkills(): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const skillsDir = join(process.cwd(), "skills");

  if (!(await Bun.file(skillsDir).exists())) {
    return skills;
  }

  // Use Bun.Glob to find skill files
  const glob = new Bun.Glob("**/*.{ts,js}");

  for await (const path of glob.scan({ cwd: skillsDir, onlyFiles: true })) {
    const fullPath = join(skillsDir, path);

    // Skip index files in subdirectories for now, handle them separately
    if (path.includes("/") && !path.endsWith("/index.ts") && !path.endsWith("/index.js")) {
      continue;
    }

    try {
      const skillModule = await import(fullPath);
      const skill = skillModule.default || skillModule;

      if (skill && typeof skill.run === "function") {
        const skillName = skill.name || path.replace(/\/(index)?\.(ts|js)$/, "").replace(/\.(ts|js)$/, "");
        skills.set(skillName, skill);
      }
    } catch (error) {
      console.error(pc.yellow(`Warning: Failed to load skill ${path}:`), error);
    }
  }

  return skills;
}

function buildAdapterContext(adapters: Adapter[]): Record<string, Record<string, (params: unknown) => Promise<unknown>>> {
  const ctx: Record<string, Record<string, (params: unknown) => Promise<unknown>>> = {};

  for (const adapter of adapters) {
    ctx[adapter.name] = {};
    for (const [methodName, method] of Object.entries(adapter.tools)) {
      ctx[adapter.name][methodName] = method.execute;
    }
  }

  return ctx;
}

// ============================================================================
// MCP Server Factory
// ============================================================================

async function createMcxServerWithDeps(
  config: MCXConfig | null,
  adapters: Adapter[],
  skills: Map<string, Skill>
) {
  return createMcxServerCore(config, adapters, skills);
}

async function createMcxServer() {
  const config = await loadConfig();
  const adapters = config?.adapters || [];
  const skills = await loadSkills();

  console.error(pc.dim(`Loaded ${adapters.length} adapter(s), ${skills.size} skill(s)`));
  return createMcxServerCore(config, adapters, skills);
}

async function createMcxServerCore(
  config: MCXConfig | null,
  adapters: Adapter[],
  skills: Map<string, Skill>
) {
  const sandbox = new BunWorkerSandbox({
    timeout: config?.sandbox?.timeout ?? 30000,
    memoryLimit: config?.sandbox?.memoryLimit ?? 128,
    allowAsync: true,
  });

  const adapterContext = buildAdapterContext(adapters);

  // Build descriptions for tool hints
  const skillNames = Array.from(skills.keys()).join(", ") || "none";
  const skillList = Array.from(skills.entries())
    .map(([name, skill]) => `- ${name}: ${skill.description || "No description"}`)
    .join("\n") || "No skills loaded";

  // Generate TypeScript types for adapters (Cloudflare pattern)
  // This provides LLM with precise type information
  const typeDeclarations = adapters.length > 0
    ? generateTypes(adapters as Parameters<typeof generateTypes>[0], { includeDescriptions: true })
    : "// No adapters loaded";
  const typeSummary = adapters.length > 0
    ? generateTypesSummary(adapters as Parameters<typeof generateTypesSummary>[0])
    : "none";

  const server = new McpServer({
    name: "mcx-mcp-server",
    version: "0.1.0",
  });

  // Tool: mcx_execute
  server.registerTool(
    "mcx_execute",
    {
      title: "Execute Code in MCX Sandbox",
      description: `Execute JavaScript/TypeScript code in an isolated sandbox.

## Available Adapters
${typeSummary}

## TypeScript API
\`\`\`typescript
${typeDeclarations}
\`\`\`

## Built-in Helpers
- pick(arr, ['id', 'name']) - Extract specific fields
- first(arr, 5) - First N items
- count(arr, 'field') - Count by field value
- sum(arr, 'field') - Sum numeric field
- table(arr) - Format as markdown table

IMPORTANT: Always filter/transform data before returning to minimize context.`,
      inputSchema: ExecuteInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: ExecuteInput) => {
      try {
        const result = await sandbox.execute(params.code, {
          adapters: adapterContext,
          env: config?.env || {},
        });

        if (!result.success) {
          const errorMsg = result.error
            ? `${result.error.name}: ${result.error.message}`
            : "Unknown error";
          return {
            content: [{ type: "text" as const, text: `Execution error: ${errorMsg}\n\nLogs:\n${result.logs.join("\n")}` }],
            isError: true,
          };
        }

        const summarized = summarizeResult(result.value);
        const textOutput = [
          result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}\n` : "",
          summarized.truncated
            ? `Result (${summarized.originalSize}):\n${JSON.stringify(summarized.value, null, 2)}`
            : result.value !== undefined
              ? `Result:\n${JSON.stringify(result.value, null, 2)}`
              : "Code executed successfully",
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text" as const, text: textOutput }],
          structuredContent: {
            result: summarized.value,
            logs: result.logs,
            executionTime: result.executionTime,
            truncated: summarized.truncated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Sandbox error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_run_skill
  server.registerTool(
    "mcx_run_skill",
    {
      title: "Run MCX Skill",
      description: `Run a registered MCX skill by name.

Available skills: [${skillNames}]
${skillList}`,
      inputSchema: RunSkillInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: RunSkillInput) => {
      const skill = skills.get(params.skill);

      if (!skill) {
        return {
          content: [{ type: "text" as const, text: `Error: Skill '${params.skill}' not found.\n\nAvailable: ${Array.from(skills.keys()).join(", ") || "none"}` }],
          isError: true,
        };
      }

      try {
        // Wrap skill execution with timeout to prevent hanging
        const timeoutMs = config?.sandbox?.timeout ?? 30000;
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Skill '${params.skill}' timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        const result = await Promise.race([
          skill.run({ inputs: params.inputs, ...adapterContext }),
          timeoutPromise,
        ]);

        return {
          content: [{ type: "text" as const, text: result !== undefined ? JSON.stringify(result, null, 2) : "Skill executed successfully" }],
          structuredContent: { result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Skill '${params.skill}' error: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // Tool: mcx_list
  server.registerTool(
    "mcx_list",
    {
      title: "List MCX Adapters and Skills",
      description: "List all available MCX adapters and skills with their methods and descriptions.",
      inputSchema: ListInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const output = {
        adapters: adapters.map((a) => ({
          name: a.name,
          description: a.description || "No description",
          methods: Object.keys(a.tools),
        })),
        skills: Array.from(skills.entries()).map(([name, skill]) => ({
          name,
          description: skill.description || "No description",
          inputs: skill.inputs,
        })),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // Tool: mcx_search
  server.registerTool(
    "mcx_search",
    {
      title: "Search MCX Adapters and Skills",
      description: `Search for adapters, methods, or skills by name or description.
Use this to discover available functionality without loading everything.
Returns TypeScript type information for matching methods.`,
      inputSchema: SearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params: SearchInput) => {
      const query = params.query.toLowerCase();
      const searchType = params.type || "all";

      const results: {
        adapters: Array<{ name: string; description: string; matchedMethods: string[] }>;
        methods: Array<{ adapter: string; method: string; description: string; typescript: string }>;
        skills: Array<{ name: string; description: string }>;
      } = {
        adapters: [],
        methods: [],
        skills: [],
      };

      // Search adapters and methods
      if (searchType === "all" || searchType === "adapters" || searchType === "methods") {
        for (const adapter of adapters) {
          const adapterMatches =
            adapter.name.toLowerCase().includes(query) ||
            (adapter.description?.toLowerCase().includes(query) ?? false);

          const matchedMethods: string[] = [];

          for (const [methodName, method] of Object.entries(adapter.tools)) {
            const methodMatches =
              methodName.toLowerCase().includes(query) ||
              (method.description?.toLowerCase().includes(query) ?? false);

            if (methodMatches || adapterMatches) {
              matchedMethods.push(methodName);

              if (searchType === "all" || searchType === "methods") {
                // Generate TypeScript signature for this method
                const params = method.parameters
                  ? Object.entries(method.parameters)
                      .map(([name, def]) => {
                        const opt = def.required === false ? "?" : "";
                        const type = def.type === "object" ? "Record<string, unknown>"
                                   : def.type === "array" ? "unknown[]"
                                   : def.type;
                        return `${name}${opt}: ${type}`;
                      })
                      .join(", ")
                  : "";

                const typescript = params
                  ? `${adapter.name}.${methodName}({ ${params} }): Promise<unknown>`
                  : `${adapter.name}.${methodName}(): Promise<unknown>`;

                results.methods.push({
                  adapter: adapter.name,
                  method: methodName,
                  description: method.description || "No description",
                  typescript,
                });
              }
            }
          }

          if ((searchType === "all" || searchType === "adapters") && (adapterMatches || matchedMethods.length > 0)) {
            results.adapters.push({
              name: adapter.name,
              description: adapter.description || "No description",
              matchedMethods,
            });
          }
        }
      }

      // Search skills
      if (searchType === "all" || searchType === "skills") {
        for (const [name, skill] of skills.entries()) {
          const matches =
            name.toLowerCase().includes(query) ||
            (skill.description?.toLowerCase().includes(query) ?? false);

          if (matches) {
            results.skills.push({
              name,
              description: skill.description || "No description",
            });
          }
        }
      }

      // Format output
      const totalMatches = results.adapters.length + results.methods.length + results.skills.length;

      if (totalMatches === 0) {
        return {
          content: [{ type: "text" as const, text: `No results found for "${params.query}"` }],
          structuredContent: results,
        };
      }

      const output = [
        `Found ${totalMatches} result(s) for "${params.query}":`,
        "",
      ];

      if (results.adapters.length > 0) {
        output.push("## Adapters");
        for (const a of results.adapters) {
          output.push(`- **${a.name}**: ${a.description}`);
          if (a.matchedMethods.length > 0) {
            output.push(`  Methods: ${a.matchedMethods.join(", ")}`);
          }
        }
        output.push("");
      }

      if (results.methods.length > 0) {
        output.push("## Methods (TypeScript)");
        for (const m of results.methods) {
          output.push(`- \`${m.typescript}\``);
          output.push(`  ${m.description}`);
        }
        output.push("");
      }

      if (results.skills.length > 0) {
        output.push("## Skills");
        for (const s of results.skills) {
          output.push(`- **${s.name}**: ${s.description}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: output.join("\n") }],
        structuredContent: results,
      };
    }
  );

  return server;
}

// ============================================================================
// Transports
// ============================================================================

async function runStdio() {
  console.error(pc.dim(`[MCX] cwd: ${process.cwd()}`));

  // Load global ~/.mcx/.env
  await loadEnvFile();

  console.error(pc.cyan("Starting MCX MCP server (stdio)...\n"));

  const server = await createMcxServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(pc.green("MCX MCP server running"));
  console.error(pc.dim("Tools: mcx_execute, mcx_run_skill, mcx_list"));
}

async function runHttp(port: number) {
  console.error(pc.dim(`[MCX] cwd: ${process.cwd()}`));

  // Load global ~/.mcx/.env
  await loadEnvFile();

  console.error(pc.cyan(`Starting MCX MCP server (HTTP:${port})...\n`));

  const config = await loadConfig();
  const skills = await loadSkills();
  const adapters = config?.adapters || [];
  console.error(pc.dim(`Loaded ${adapters.length} adapter(s), ${skills.size} skill(s)`));

  Bun.serve({
    port,
    hostname: "127.0.0.1",

    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok", server: "mcx-mcp-server", version: "0.1.0" });
      }

      if (req.method === "POST" && url.pathname === "/mcp") {
        try {
          const body = await req.json();
          const server = await createMcxServerWithDeps(config, adapters, skills);

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });

          await server.connect(transport);

          const mockRes = {
            statusCode: 200,
            headers: {} as Record<string, string>,
            body: "",
            setHeader(name: string, value: string) { this.headers[name] = value; },
            end(data?: string) { this.body = data || ""; },
            write(data: string) { this.body += data; },
            on() {},
          };

          await transport.handleRequest(req as never, mockRes as never, body);

          return new Response(mockRes.body, {
            status: mockRes.statusCode,
            headers: mockRes.headers,
          });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.error(pc.green(`MCX MCP server running on http://127.0.0.1:${port}/mcp`));
  console.error(pc.dim("Health: GET /health"));
}

// ============================================================================
// Export
// ============================================================================

export interface ServeOptions {
  transport?: "stdio" | "http";
  port?: number;
  cwd?: string;
}

export async function serveCommand(options: ServeOptions = {}): Promise<void> {
  // If cwd is explicitly provided, use it (backward compatible)
  if (options.cwd) {
    // Check if it's a project-local config
    const projectRoot = findProjectRoot(options.cwd);
    if (projectRoot) {
      process.chdir(projectRoot);
      console.error(pc.dim(`[MCX] Using project: ${projectRoot}`));
    } else {
      process.chdir(options.cwd);
      console.error(pc.dim(`[MCX] Using cwd: ${options.cwd}`));
    }
  } else {
    // Default: use global ~/.mcx/ directory
    const mcxHome = ensureMcxHomeDir();
    console.error(pc.dim(`[MCX] Using global: ${mcxHome}`));
    process.chdir(mcxHome);
  }

  if (options.transport === "http") {
    await runHttp(options.port || 3100);
  } else {
    await runStdio();
  }
}
