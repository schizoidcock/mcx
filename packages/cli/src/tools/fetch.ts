/**
 * mcx_fetch Tool
 * 
 * Fetch URL, convert to markdown, index in FTS5, and optionally search.
 * Caches 24h - same URL returns cached results instantly.
 */

import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError, formatBytes } from "./utils.js";
import { errorTips } from "../context/tips.js";
import { trackToolUsage, suggestNextTool, trackNetworkBytes } from "../context/tracking.js";
import { htmlToMarkdown, extractHtmlTitle } from "../search/html-to-markdown.js";
import { isBlockedUrl } from "../utils/security.js";

// ============================================================================
// Types
// ============================================================================

export interface FetchParams {
  url: string;
  queries?: string[];
  force?: boolean;
  preview?: boolean;
  timeout?: number;
}

interface CachedUrl {
  sourceId: string;
  label: string;
  timestamp: number;
  sizeKB?: number;
}

// ============================================================================
// Cache
// ============================================================================

const URL_CACHE_MAX_SIZE = 100;
const URL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

const urlCache = new Map<string, CachedUrl>();

function getCachedUrl(url: string): CachedUrl | null {
  const cached = urlCache.get(url);
  if (!cached) return null;
  
  const age = Date.now() - cached.timestamp;
  if (age > URL_CACHE_TTL) {
    urlCache.delete(url);
    return null;
  }
  
  return cached;
}

function setCachedUrl(url: string, data: Omit<CachedUrl, "timestamp">): void {
  // Evict oldest if full
  if (urlCache.size >= URL_CACHE_MAX_SIZE) {
    const oldest = urlCache.keys().next().value;
    if (oldest) urlCache.delete(oldest);
  }
  
  urlCache.set(url, { ...data, timestamp: Date.now() });
}

// ============================================================================
// Helpers
// ============================================================================

function formatAge(ms: number): string {
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

function getPreview(content: string, maxLen: number = 3000): string {
  return content.length <= maxLen ? content : content.slice(0, maxLen) + "\n\n... [truncated]";
}

function searchQueries(
  store: ToolContext["contentStore"],
  queries: string[],
  sourceId: string
): string[] {
  const output: string[] = ["", "Search Results:", ""];
  for (const query of queries) {
    const results = store.search(query, { limit: 5, source: sourceId });
    if (results.length === 0) continue;
    output.push(`## ${query}`);
    results.forEach((r) => output.push(`- ${r.text.slice(0, 200)}`));
    output.push("");
  }
  return output.length > 3 ? output : [];
}

function extractLabelFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const lastPart = path !== "/" ? path.split("/").filter(Boolean).pop() : null;
    const suffix = lastPart ? " - " + lastPart.replace(/[-_]/g, " ").replace(/\.\w+$/, "") : "";
    return urlObj.hostname + suffix;
  } catch {
    return "fetched";
  }
}

function extractLabelFromJson(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  // OpenAPI spec
  if (obj.info && typeof obj.info === "object") {
    const info = obj.info as Record<string, string>;
    if (info.title) return info.title;
  }
  // Generic title
  if (typeof obj.title === "string") return obj.title;
  return null;
}

function formatCacheHit(
  label: string,
  chunks: number,
  sizeKB: number | undefined,
  age: number,
  searchOutput: string[]
): McpResult {
  const lines = [
    `✓ ${label} | ${chunks} sections | ${sizeKB || "?"}KB | cached ${formatAge(age)}`,
    `-> mcx_search({ queries: [...] }) or force: true`,
    ...searchOutput,
  ];
  return lines.join("\n");
}

// ============================================================================
// Handler
// ============================================================================

async function handleFetch(
  ctx: ToolContext,
  params: FetchParams
): Promise<McpResult> {
  const { url, queries: rawQueries, force = false, preview = false, timeout } = params;
  
  if (!url) {
    return formatError("Missing url parameter");
  }
  
  // Validate queries if provided
  const queries = rawQueries ?? [];
  if (rawQueries !== undefined && !Array.isArray(rawQueries)) {
    return formatError(
      `queries must be an array\n` +
      `💡 Example: mcx_fetch({ url: "...", queries: ["term1", "term2"] })`
    );
  }
  
  // Check cache (early return)
  const cached = !force ? getCachedUrl(url) : null;
  if (cached) {
    const age = Date.now() - cached.timestamp;
    const chunks = ctx.contentStore.getChunkCount(cached.sourceId);
    const searchOutput = queries.length > 0 
      ? searchQueries(ctx.contentStore, queries, cached.sourceId) 
      : [];
    trackToolUsage("mcx_fetch");
    return formatCacheHit(cached.label, chunks, cached.sizeKB, age, searchOutput);
  }
  
  // SSRF protection
  const ssrfCheck = isBlockedUrl(url);
  if (ssrfCheck.blocked) {
    return formatError(`SSRF blocked: ${ssrfCheck.reason}`);
  }
  
  try {
    // Fetch URL
    const response = await fetch(url);
    if (!response.ok) {
      return formatError(`Fetch failed: ${response.status} ${response.statusText}`);
    }
    
    const contentType = response.headers.get("content-type") || "";
    let content: string;
    let label: string;
    let indexType: "text" | "json" | "markdown" = "text";
    
    label = extractLabelFromUrl(url);
    
    // Parse content based on type
    if (contentType.includes("json")) {
      const json = await response.json();
      content = JSON.stringify(json, null, 2);
      indexType = "json";
      
      label = extractLabelFromJson(json) || label;
    } else if (contentType.includes("html")) {
      const html = await response.text();
      content = htmlToMarkdown(html);
      indexType = "markdown";
      // Extract title from HTML if available
      const title = extractHtmlTitle(html);
      if (title) label = title;
    } else {
      content = await response.text();
    }
    
    // Index content
    const sourceId = ctx.contentStore.index(content, label, { contentType: indexType });
    const chunks = ctx.contentStore.getChunkCount(sourceId);
    const sizeKB = Math.round(content.length / 1024 * 10) / 10;
    
    // Track network I/O
    trackNetworkBytes(content.length, url.length);
    
    // Update cache
    setCachedUrl(url, { sourceId, label, sizeKB });
    
    // Build output
    const output: string[] = [
      `✓ ${label} | ${chunks} sections | ${sizeKB}KB`,
    ];
    
    // Search if queries provided
    if (queries.length > 0) {
      output.push("");
      output.push("Search Results:");
      output.push("");
      
      for (const query of queries) {
        const results = ctx.contentStore.search(query, { limit: 5, source: sourceId });
        if (results.length > 0) {
          output.push(`## ${query}`);
          output.push("");
          for (const r of results) {
            output.push(r.snippet);
            output.push("");
          }
        } else {
          output.push(`## ${query}`);
          output.push("(no matches)");
          output.push("");
        }
      }
      
      output.push(`-> Try mcx_search({ queries: [...] }) with different terms`);
    } else if (preview) {
      output.push("Full content indexed — use mcx_search({ queries: [...] }) for retrieval");
      output.push("");
      output.push("---");
      output.push(getPreview(content));
      output.push("---");
    } else {
      output.push("Full content indexed — use mcx_search({ queries: [...] }) for retrieval");
    }
    
    trackToolUsage("mcx_fetch");
    return output.join("\n") + (suggestNextTool("mcx_fetch") || "");
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return formatError(`Fetch error: ${msg}`);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxFetch: ToolDefinition<FetchParams> = {
  name: "mcx_fetch",
  description: `Fetch URL, convert to markdown, index in FTS5, and optionally search.
Caches 24h - same URL returns cached results instantly.

WORKFLOW: Fetch once with queries to get relevant content immediately.
If queries don't match, use mcx_search with different terms on the cached content.

Examples:
- mcx_fetch({ url: "https://docs.example.com/guide", queries: ["authentication", "setup"] })
- mcx_fetch({ url: "https://api.example.com/openapi.json" }) // index only
- mcx_fetch({ url: "...", force: true }) // bypass 24h cache`,
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch",
      },
      queries: {
        type: "array",
        items: { type: "string" },
        description: "Search after indexing",
      },
      force: {
        type: "boolean",
        description: "Bypass cache and re-fetch",
        default: false,
      },
      preview: {
        type: "boolean",
        description: "Return 3KB preview (full content still indexed)",
        default: false,
      },
      timeout: {
        type: "number",
        minimum: 1000,
        maximum: 60000,
        description: "Fetch timeout in ms (default: 30000)",
      },
    },
    required: ["url"],
  },
  handler: handleFetch,
};

export default mcxFetch;
