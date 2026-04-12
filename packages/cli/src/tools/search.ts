/**
 * mcx_search Tool
 * 
 * Search adapters, specs, and indexed content.
 * Modes: spec exploration, content search, adapter/method search.
 */

import type { ToolContext, ToolDefinition, McpResult, AdapterSpec } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export interface SearchParams {
  code?: string;
  queries?: string[];
  adapter?: string;
  storeAs?: string;
  limit?: number;
}

interface SearchResult {
  text: string;
  snippet: string;
  score: number;
  source?: string;
}

// ============================================================================
// Mode 1: Spec Exploration
// ============================================================================

async function handleSpecSearch(
  ctx: ToolContext,
  code: string,
  storeAs?: string
): Promise<McpResult> {
  if (!ctx.spec) {
    return formatError("No spec loaded. Use mcx_doctor() to check config.");
  }
  
  try {
    const result = await ctx.sandbox.execute(code, { $spec: ctx.spec });
    const value = result.value;
    
    // Store if requested
    if (storeAs) {
      ctx.variables.stored.set(storeAs, {
        value,
        timestamp: Date.now(),
        source: "mcx_search:spec",
      });
    }
    
    // Format output
    const output = formatSpecResult(value);
    const storedMsg = storeAs ? `\nStored as $${storeAs}` : "";
    
    return formatToolResult(output + storedMsg);
  } catch (err) {
    return formatError(`Spec query failed: ${String(err)}`);
  }
}

function formatSpecResult(value: unknown): string {
  if (value === undefined) return "(undefined)";
  if (value === null) return "(null)";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length <= 10) return JSON.stringify(value, null, 2);
    return `[${value.length} items]\n${JSON.stringify(value.slice(0, 5), null, 2)}\n... +${value.length - 5} more`;
  }
  if (typeof value === "object") {
    const json = JSON.stringify(value, null, 2);
    return json.length > 3000 ? json.slice(0, 3000) + "\n... [truncated]" : json;
  }
  return String(value);
}

// ============================================================================
// Mode 2: Content Search (FTS5)
// ============================================================================

function handleContentSearch(
  ctx: ToolContext,
  queries: string[],
  limit: number = 5,
  storeAs?: string
): McpResult {
  const results: Array<{ query: string; matches: SearchResult[] }> = [];
  
  for (const query of queries) {
    const matches = ctx.contentStore.search(query, { limit });
    results.push({ query, matches });
  }
  
  // Store if requested
  if (storeAs) {
    ctx.variables.stored.set(storeAs, {
      value: results,
      timestamp: Date.now(),
      source: "mcx_search:content",
    });
  }
  
  // Format output
  const output = formatContentResults(results);
  
  return formatToolResult(output);
}

function formatContentResults(
  results: Array<{ query: string; matches: SearchResult[] }>
): string {
  const lines: string[] = [];
  
  for (const { query, matches } of results) {
    lines.push(`## ${query}`);
    
    if (matches.length === 0) {
      lines.push("(no matches)");
    } else {
      for (const m of matches) {
        const source = m.source ? ` [${m.source}]` : "";
        lines.push(`- ${m.snippet.slice(0, 200)}${source}`);
      }
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

// ============================================================================
// Mode 3: Adapter/Method Search
// ============================================================================

function handleAdapterSearch(
  spec: AdapterSpec,
  query: string
): McpResult {
  const lowerQuery = query.toLowerCase();
  const matches: string[] = [];
  
  for (const adapter of spec.adapters) {
    // Match adapter name
    if (adapter.name.toLowerCase().includes(lowerQuery)) {
      matches.push(`${adapter.name} (adapter)`);
    }
    
    // Match methods
    for (const method of adapter.methods || []) {
      if (method.name.toLowerCase().includes(lowerQuery)) {
        matches.push(`${adapter.name}.${method.name}`);
      }
    }
  }
  
  if (matches.length === 0) {
    return formatToolResult(`No matches for "${query}"`);
  }
  
  const output = [
    `Found ${matches.length} matches for "${query}":`,
    "",
    ...matches.slice(0, 20).map((m) => `- ${m}`),
  ];
  
  if (matches.length > 20) {
    output.push(`... +${matches.length - 20} more`);
  }
  
  output.push("");
  output.push("→ mcx_adapter({ name: \"...\", call: \"...\" }) to call");
  
  return formatToolResult(output.join("\n"));
}

// ============================================================================
// Main Handler
// ============================================================================

async function handleSearch(
  ctx: ToolContext,
  params: SearchParams
): Promise<McpResult> {
  const { code, queries, adapter, storeAs, limit = 5 } = params;
  
  // Mode 1: Spec exploration
  if (code) {
    return handleSpecSearch(ctx, code, storeAs);
  }
  
  // Mode 2: Content search
  if (queries?.length) {
    return handleContentSearch(ctx, queries, limit, storeAs);
  }
  
  // Mode 3: Adapter search
  if (adapter) {
    if (!ctx.spec) return formatError("No spec loaded");
    return handleAdapterSearch(ctx.spec, adapter);
  }
  
  // No mode specified
  return formatError(
    "Specify one of: code (spec query), queries (content search), adapter (method search)\n" +
    "Examples:\n" +
    "- mcx_search({ code: \"Object.keys($spec.adapters)\" })\n" +
    "- mcx_search({ queries: [\"error handling\"] })\n" +
    "- mcx_search({ adapter: \"stripe\" })"
  );
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxSearch: ToolDefinition<SearchParams> = {
  name: "mcx_search",
  description: `Search adapters, specs, and indexed content.

## Mode 1: Spec Exploration (code param)
Query $spec with JS. All $refs pre-resolved.
- mcx_search({ code: "Object.keys($spec.adapters)" })
- mcx_search({ code: "$spec.adapters.stripe.tools.createCustomer" })

## Mode 2: Content Search (queries param)
Full-text search indexed content (from mcx_fetch, mcx_file).
- mcx_search({ queries: ["authentication flow"] })
- mcx_search({ queries: ["error handling", "retry logic"], limit: 3 })

## Mode 3: Adapter/Method Search (adapter param)
Find adapter methods by name.
- mcx_search({ adapter: "create" }) → all methods with "create"
- mcx_search({ adapter: "stripe" }) → all stripe methods`,
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "JS code to query $spec" },
      queries: {
        type: "array",
        items: { type: "string" },
        description: "Full-text search queries",
      },
      adapter: { type: "string", description: "Search adapter/method names" },
      storeAs: { type: "string", description: "Store results as variable" },
      limit: { type: "number", description: "Max results per query (default: 5)" },
    },
  },
  handler: handleSearch,
};

export default mcxSearch;
