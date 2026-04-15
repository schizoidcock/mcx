/**
 * mcx_search Tool
 * 
 * Search adapters, specs, and indexed content.
 * Modes: spec exploration, content search, adapter/method search.
 */

import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import type { ResolvedSpec, ToolSpec, ParameterSpec } from "../spec/types.js";
import type { ContentStore } from "../search/store.js";
import { formatError } from "./utils.js";
import { getMethodFrecency } from "../context/tracking.js";
import { getSandboxState } from "../sandbox/index.js";
import { checkSearchThrottle } from "../context/guards.js";
import { MAX_PARAMS_FULL, MAX_PARAMS_TRUNCATED, MAX_DESC_LENGTH } from "./constants.js";

// ============================================================================
// Types
// ============================================================================

export interface SearchParams {
  code?: string;
  queries?: string[];
  adapter?: string;
  storeAs?: string;
  limit?: number;
  source?: string;  // Filter by indexed source label
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
      getSandboxState().set(storeAs, value);
    }
    
    // Format output
    const output = formatSpecResult(value);
    const storedMsg = storeAs ? `\nStored as $${storeAs}` : "";
    
    return output + storedMsg;
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

// Helper: resolve source label to sourceIds (exact or partial match)
function resolveSourceIds(store: ContentStore, source: string): number[] | undefined {
  const exact = store.getSourceByLabel(source);
  if (exact) return [exact.id];
  
  const partial = store.getSources().find(s => s.label.includes(source));
  return partial ? [partial.id] : undefined;
}

function handleContentSearch(
  ctx: ToolContext,
  queries: string[],
  limit: number = 5,
  storeAs?: string,
  source?: string
): McpResult {
  const sourceIds = source ? resolveSourceIds(ctx.contentStore, source) : undefined;
  const results = queries.map(query => ({
    query,
    matches: ctx.contentStore.search(query, { limit, sourceIds }),
  }));
  
  if (storeAs) getSandboxState().set(storeAs, results);
  
  return formatContentResults(results);
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
        lines.push(`- ${(m.snippet || m.text || '').slice(0, 200)}${source}`);
      }
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

// ============================================================================
// Mode 3: Adapter/Method Search
// ============================================================================



/** Format single parameter line */
function formatParam(p: ParameterSpec): string[] {
  const req = p.required ? "(required)" : "(optional)";
  const def = p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : "";
  const desc = p.description?.length > MAX_DESC_LENGTH 
    ? p.description.slice(0, MAX_DESC_LENGTH - 3) + "..." : p.description;
  const lines = [`- **${p.name}**: \`${p.type}\` ${req}${def}`];
  if (desc) lines.push(`  ${desc}`);
  return lines;
}

/** Format detailed method view for exact match */
function formatMethodDetail(adapterName: string, method: ToolSpec): string {
  const lines = [`## ${adapterName}.${method.name}`, ""];
  if (method.description) lines.push(method.description, "");
  
  const params = method.parameters || [];
  const sig = params.map(p => `${p.name}${p.required ? "" : "?"}: ${p.type}`).join(", ");
  lines.push("### Signature", `${adapterName}.${method.name}({ ${sig} })`, "");
  
  if (params.length === 0) return lines.join("\n");
  
  const showAll = params.length <= MAX_PARAMS_FULL;
  const toShow = showAll ? params : params.slice(0, MAX_PARAMS_TRUNCATED);
  lines.push(`### Parameters${showAll ? "" : ` (${MAX_PARAMS_TRUNCATED}/${params.length})`}`);
  lines.push(...toShow.flatMap(formatParam), "");
  return lines.join("\n");
}

interface MethodMatch { adapter: string; method: string; spec: ToolSpec }

function handleAdapterSearch(spec: ResolvedSpec, query: string): McpResult {
  const lowerQuery = query.toLowerCase();
  const adapterMatches: string[] = [];
  const methodMatches: MethodMatch[] = [];
  
  for (const adapter of Object.values(spec.adapters)) {
    if (adapter.name.toLowerCase().includes(lowerQuery)) {
      adapterMatches.push(`${adapter.name} (adapter)`);
    }
    for (const method of Object.values(adapter.tools || {})) {
      if (method.name.toLowerCase().includes(lowerQuery)) {
        methodMatches.push({ adapter: adapter.name, method: method.name, spec: method });
      }
    }
  }
  
  methodMatches.sort((a, b) => getMethodFrecency(b.adapter, b.method) - getMethodFrecency(a.adapter, a.method));
  
  // Exact match: show detailed view
  const isExact = methodMatches.length === 1 && methodMatches[0].method.toLowerCase() === lowerQuery;
  if (isExact && adapterMatches.length === 0) {
    return formatMethodDetail(methodMatches[0].adapter, methodMatches[0].spec);
  }
  
  // Multiple matches: show list
  const allMatches = [...adapterMatches, ...methodMatches.map(m => `${m.adapter}.${m.method}`)];
  if (allMatches.length === 0) return `No matches for "${query}"`;
  
  const output = [`Found ${allMatches.length} matches for "${query}":`, ""];
  output.push(...allMatches.slice(0, 20).map(m => `- ${m}`));
  if (allMatches.length > 20) output.push(`... +${allMatches.length - 20} more`);
  output.push("", "→ mcx_adapter({ name: \"...\", call: \"methodName\", params: {...} }) to execute");
  return output.join("\n");
}
// ============================================================================
// Main Handler
// ============================================================================

async function handleSearch(
  ctx: ToolContext,
  params: SearchParams
): Promise<McpResult> {
  // Throttle check (skip for spec exploration which is lightweight)
  const throttle = checkSearchThrottle();
  if (throttle.blocked) {
    return formatError(`Search throttled (${throttle.calls} calls in window). Wait a moment.`);
  }
  
  const { code, queries, adapter, storeAs, limit = 5, source } = params;
  const effectiveLimit = throttle.reducedLimit ? Math.min(limit, 3) : limit;
  
  // Mode 1: Spec exploration
  if (code) {
    return handleSpecSearch(ctx, code, storeAs);
  }
  
  // Mode 2: Content search
  if (queries !== undefined) {
    if (!Array.isArray(queries)) {
      return formatError(
        `queries must be an array\n` +
        `💡 Example: mcx_search({ queries: ["term1", "term2"] })`
      );
    }
    if (queries.length > 0) {
      return handleContentSearch(ctx, queries, effectiveLimit, storeAs, source);
    }
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
      limit: { type: "number", minimum: 1, maximum: 100, default: 5, description: "Max results per query" },
      source: { type: "string", description: "Filter by indexed source label (e.g., 'file:path' or 'exec:var')" },
    },
  },
  handler: handleSearch,
};

export default mcxSearch;
