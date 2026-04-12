/**
 * Tool Registration
 * 
 * Centralizes MCP tool registration using extracted handlers.
 * Replaces inline handlers in serve.ts with modular imports.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileFinder } from "@ff-labs/fff-bun";
import type { ToolContext, SkillDef, McpResult } from "./types.js";

// Import extracted tools
import { mcxWrite } from "./write.js";
import { mcxDoctor } from "./doctor.js";
import { mcxUpgrade } from "./upgrade.js";
import { mcxWatch } from "./watch.js";
import { mcxGrep } from "./grep.js";
import { mcxFind } from "./find.js";
import { mcxEdit } from "./edit.js";
import { mcxFetch } from "./fetch.js";
import { mcxStats } from "./stats.js";
import { mcxTasks } from "./tasks.js";
import { createAdapterTool } from "./adapter.js";
import { mcxFile } from "./file.js";
import { mcxSearch } from "./search.js";
import { createExecuteTool } from "./execute.js";

// ============================================================================
// Types
// ============================================================================

type WithFinderFn = <T>(
  searchPath: string | undefined,
  fn: (finder: FileFinder) => T | Promise<T>
) => Promise<T | McpResult>;

interface RegisterOptions {
  server: McpServer;
  ctx: ToolContext;
  skills: Map<string, SkillDef>;
  withFinder: WithFinderFn;
}

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * Register all extracted MCP tools with the server.
 * Each tool receives the shared ToolContext for dependency injection.
 */
export function registerExtractedTools(options: RegisterOptions): void {
  const { server, ctx, skills, withFinder } = options;
  
  // Create dynamic tools (need runtime data)
  const adapterTool = createAdapterTool(skills);
  const executeTool = createExecuteTool(ctx.spec);
  
  // All tools to register
  const tools = [
    mcxWrite,
    mcxDoctor,
    mcxUpgrade,
    mcxWatch,
    mcxGrep,
    mcxFind,
    mcxEdit,
    mcxFetch,
    mcxStats,
    mcxTasks,
    adapterTool,
    mcxFile,
    mcxSearch,
    executeTool,
  ];
  
  // Register each tool
  for (const tool of tools) {
    registerTool(server, ctx, tool, withFinder);
  }
}

/**
 * Register a single tool with proper schema conversion.
 * Tools with needsFinder=true get wrapped with withFinder.
 */
function registerTool(
  server: McpServer,
  ctx: ToolContext,
  tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (ctx: ToolContext, params: unknown) => Promise<unknown>;
    needsFinder?: boolean;
  },
  withFinder: WithFinderFn
): void {
  const zodSchema = jsonSchemaToZod(tool.inputSchema);
  
  server.registerTool(
    tool.name,
    {
      title: tool.name,
      description: tool.description,
      inputSchema: zodSchema,
    },
    async (params) => {
      if (tool.needsFinder) {
        // Extract path from params for finder scope
        const pathParam = (params as { path?: string }).path;
        return withFinder(pathParam, async (finder) => {
          const ctxWithFinder = { ...ctx, finder };
          return tool.handler(ctxWithFinder, params);
        });
      }
      return tool.handler(ctx, params);
    }
  );
}

/**
 * Convert JSON Schema to Zod schema.
 * Handles common cases for MCP tool schemas.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (schema.type !== "object") {
    return z.any();
  }
  
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) {
    return z.object({});
  }
  
  const required = (schema.required as string[]) || [];
  const shape: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, prop] of Object.entries(properties)) {
    let field = convertProperty(prop);
    
    // Add description
    if (prop.description) {
      field = field.describe(prop.description as string);
    }
    
    // Make optional if not required
    if (!required.includes(key)) {
      field = field.optional();
    }
    
    shape[key] = field;
  }
  
  return z.object(shape);
}

/**
 * Convert a single JSON Schema property to Zod.
 */
function convertProperty(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string;
  
  switch (type) {
    case "string":
      if (prop.enum) {
        return z.enum(prop.enum as [string, ...string[]]);
      }
      return z.string();
    
    case "number":
    case "integer":
      return z.number();
    
    case "boolean":
      return z.boolean();
    
    case "array":
      const items = prop.items as Record<string, unknown> | undefined;
      if (items) {
        return z.array(convertProperty(items));
      }
      return z.array(z.any());
    
    case "object":
      return z.record(z.any());
    
    default:
      return z.any();
  }
}

export default registerExtractedTools;
