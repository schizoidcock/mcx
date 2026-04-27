/**
 * Tool Registration
 *
 * - Annotations derived from meta.ts
 * - Tips from context/tips.ts
 * - Tracking from context/tracking.ts
 * - Max 3 indentation levels
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FileFinder } from "@ff-labs/fff-bun";
import type { ToolContext, SkillDef, McpResult } from "./types.js";


import { getToolMeta, deriveAnnotations, booleanLike } from "./meta.js";
import { getTips, errorTips, type TipContext } from "../context/tips.js";
import { trackToolUsage, getRecentTools, trackToolOutput } from "../context/tracking.js";
import { summarizeResult, enforceCharacterLimit } from "../utils/truncate.js";
import { formatToolResult, formatError } from "./utils.js";
import { debugRegister as debug } from "../utils/debug.js";
import { getAccessCount } from "../context/files.js";
import { coerceArrayParams } from "../utils/zod.js";
import { compressStale, getPathByFileVar } from "../context/variables.js";
import { logger } from "../utils/logger.js";
import { runPeriodicCleanup } from "../context/cleanup.js";
import { findSimilarParams } from "../utils/fuzzy.js";

// Import extracted tools
import { mcxDoctor } from "./doctor.js";
import { mcxUpgrade } from "./upgrade.js";
import { mcxWatch } from "./watch.js";
import { mcxGrep } from "./grep.js";
import { mcxFind } from "./find.js";
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

/** Check if MCP result contains image content (skip truncation for images) */
function hasImageContent(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const r = result as Record<string, unknown>;
  if (!('content' in r) || !Array.isArray(r.content)) return false;
  return r.content.some(c => typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'image');
}

/**
 * Register all extracted MCP tools with the server.
 * Each tool receives the shared ToolContext for dependency injection.
 */

/** Check if result has text content that can be modified */
function getTextContent(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  if (!('content' in result)) return undefined;
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content[0]?.type === 'text' ? r.content[0].text : undefined;
}

/** Set text content on McpResult */
function setTextContent(result: unknown, text: string): void {
  const r = result as { content: Array<{ type: string; text?: string }> };
  if (r.content[0]) r.content[0].text = text;
}

export function registerExtractedTools(options: RegisterOptions): void {
  debug.debug("registerExtractedTools", { toolCount: 12 });
  const { server, ctx, skills, withFinder } = options;
  // Create dynamic tools (need runtime data)
  const adapterTool = createAdapterTool(skills);
  const executeTool = createExecuteTool(ctx.spec);

  // All tools to register
  const tools = [
    mcxDoctor,
    mcxUpgrade,
    mcxWatch,
    mcxGrep,
    mcxFind,
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
 * Register a single tool with annotations and tracking.
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
  const meta = getToolMeta(tool.name);
  const annotations = meta ? deriveAnnotations(meta) : undefined;

  server.registerTool(
    tool.name,
    {
      title: tool.name,
      description: tool.description,
      inputSchema: zodSchema,
      ...(annotations && { annotations }),
    },
    async (params) => {
      debug.debug("toolCall", { tool: tool.name, params: Object.keys(params) });
      const p = params as Record<string, unknown>;
      coerceArrayParams(p, tool.inputSchema);
      const filePath = (p.path || p.file_path || (p.storeAs && getPathByFileVar(p.storeAs as string))) as string | undefined;
      const start = Date.now();

      // Validate unknown params (ONE source of truth: inputSchema)
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
      const validParams = Object.keys(properties || {});
      const unknown = Object.keys(p).filter(k => !validParams.includes(k));
      if (unknown.length > 0) {
        const suggestions = unknown.flatMap(u => findSimilarParams(u, validParams));
        const didYouMean = suggestions.length > 0 ? `\nDid you mean: ${[...new Set(suggestions)].join(", ")}?` : "";
        return formatError(
          `Unknown parameter: ${unknown.join(", ")}${didYouMean}\n` +
          errorTips.validParams(validParams)
        );
      }

      // Validate param types using convertProperty + safeParse
      if (properties) {
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, prop] of Object.entries(properties)) {
          shape[key] = convertProperty(prop).optional();
        }
        const result = z.object(shape).passthrough().safeParse(p);
        if (!result.success) {
          const issue = result.error.issues[0];
          const path = issue.path.join('.');
          return formatError(
            `${path}: ${issue.message}\n` +
            errorTips.validParams(validParams)
          );
        }
      }

      // Track usage
      trackToolUsage(tool.name, filePath);

      // Execute handler (returns raw result)
      let rawResult: unknown;
      let errorInfo: { message: string; why?: string; fix?: string } | undefined;
      
      try {
        rawResult = await executeHandler(tool, ctx, p, filePath, withFinder);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errorInfo = { message: msg };
        rawResult = formatError(msg);
      }

      // Skip truncation if already McpResult (already formatted by handler)
      const isMcpResult = typeof rawResult === 'object' && rawResult !== null && 
                          'content' in rawResult && Array.isArray((rawResult as any).content);
      const { value: truncatedResult, rawBytes, truncatedBytes } = isMcpResult
        ? { value: rawResult, truncated: false, rawBytes: JSON.stringify(rawResult)?.length ?? 0 }
        : summarizeResult(rawResult, {
            enabled: !hasImageContent(rawResult),
            maxItems: 100,
            maxStringLength: 1500,
          });
      const responseChars = truncatedBytes ?? JSON.stringify(truncatedResult).length;
      const isError = !!errorInfo || (typeof rawResult === 'object' && rawResult !== null && 'isError' in rawResult);
      
      // Extract error context if present in result
      if (!errorInfo && isError && typeof rawResult === 'object' && rawResult !== null) {
        const r = rawResult as Record<string, unknown>;
        if (r.content && Array.isArray(r.content) && r.content[0]?.text) {
          errorInfo = { message: String(r.content[0].text).slice(0, 200) };
        }
      }
      
      trackToolOutput(tool.name, responseChars, rawBytes, isError);
      
      // Log tool event to file
      logger.tool({
        tool: tool.name,
        ok: !isError,
        ms: Date.now() - start,
        ch: responseChars,
        raw: rawBytes,
        ...(errorInfo && { err: errorInfo.message }),
      });

      // Compress stale variables + periodic cleanup
      // If variable is indexed in FTS5 -> safe to compress (data still searchable)
      const isIndexed = (varName: string) => {
        if (ctx.contentStore.hasSource(`exec:${varName}`)) return true;
        const path = getPathByFileVar(varName);
        return path ? ctx.contentStore.hasSource(`file:${path}`) : false;
      };
      compressStale(5 * 60 * 1000, 1000, isIndexed);
      runPeriodicCleanup(ctx.backgroundTasks);

      // Add tips if available
      const result = addTipsToResult(tool.name, p, filePath, truncatedResult);
      
      // HIGH-3: Apply character limit to McpResult text content
      const text = getTextContent(result);
      if (text) {
        setTextContent(result, enforceCharacterLimit(text));
        return result;
      }
      
      // Return as-is if McpResult without text, or format if raw value
      if (typeof result === 'object' && result !== null && 'content' in result) {
        return result;
      }
      return formatToolResult(String(result ?? ''), undefined, `tool:${tool.name}`);
    }
  );
}

/** Execute tool handler - handles needsFinder logic */
async function executeHandler(
  tool: { handler: (ctx: ToolContext, params: unknown) => Promise<unknown>; needsFinder?: boolean },
  ctx: ToolContext,
  params: Record<string, unknown>,
  filePath: string | undefined,
  withFinder: WithFinderFn
): Promise<unknown> {
  if (!tool.needsFinder) return tool.handler(ctx, params);

  return withFinder(undefined, async (finder) => {
    const ctxWithFinder = { ...ctx, finder };
    return tool.handler(ctxWithFinder, params);
  });
}

/** Add tips to result if applicable */
function addTipsToResult(
  toolName: string,
  params: Record<string, unknown>,
  filePath: string | undefined,
  result: unknown
): unknown {
  const meta = getToolMeta(toolName);
  if (!meta) return result;

  // Extract _meta from result if present
  const resultMeta = (typeof result === 'object' && result !== null && '_meta' in result)
    ? (result as Record<string, unknown>)._meta as TipContext['resultMeta']
    : undefined;

  const tipContext: TipContext = {
    meta,
    params,
    recentTools: getRecentTools(10).slice(0, -1), // Exclude current tool
    filePath,
    resultMeta,
  };

  const tips = getTips(tipContext);
  if (tips.length === 0) return result;

  // Append tips to content text (not as separate field)
  const tipText = tips.map(t => `💡 ${t}`).join('\n');
  if (typeof result === 'string') return result + '\n' + tipText;
  
  // If McpResult with text content, append tips
  const text = getTextContent(result);
  if (text) {
    setTextContent(result, text + '\n' + tipText);
  }
  return result;
}

/**
 * Permissive Zod schema for MCP SDK compatibility.
 * 
 * Real validation happens via convertProperty + safeParse in the handler,
 * which allows formatError to provide user-friendly messages.
 */
function jsonSchemaToZod(_schema: Record<string, unknown>): z.ZodTypeAny {
  return z.record(z.unknown());
}

/**
 * Convert a single JSON Schema property to Zod.
 * Reads min/max from JSON Schema and applies Zod limits.
 */
function convertProperty(prop: Record<string, unknown>): z.ZodTypeAny {
  const type = prop.type as string;

  switch (type) {
    case "string":
      if (prop.enum) {
        return z.enum(prop.enum as [string, ...string[]]);
      }
      let str = z.string();
      // Apply minLength/maxLength if specified
      if (typeof prop.minLength === "number") str = str.min(prop.minLength);
      if (typeof prop.maxLength === "number") str = str.max(prop.maxLength);
      return str;

    case "number":
    case "integer":
      // z.coerce handles "123" -> 123 (Claude sends strings)
      let num = z.coerce.number();
      // Apply min/max if specified in JSON Schema
      if (typeof prop.minimum === "number") num = num.min(prop.minimum);
      if (typeof prop.maximum === "number") num = num.max(prop.maximum);
      return num;

    case "boolean":
      // booleanLike handles "true"/"false" -> true/false
      return booleanLike;

    case "array":
      const items = prop.items as Record<string, unknown> | undefined;
      let arr = items ? z.array(convertProperty(items)) : z.array(z.any());
      if (typeof prop.minItems === "number") arr = arr.min(prop.minItems);
      if (typeof prop.maxItems === "number") arr = arr.max(prop.maxItems);
      return arr;

    case "object":
      return z.record(z.any());

    default:
      return z.any();
  }
}

export default registerExtractedTools;
