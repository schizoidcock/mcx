/**
 * mcx_stats Tool
 * 
 * Session statistics: indexed content, variables, tool usage.
 */

import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatBytes } from "./utils.js";
import { getVariableSummary } from "../context/variables.js";
import { getRecentTools, getRecentFiles, getTopMethods, getSessionStats } from "../context/tracking.js";

import { createDebugger } from "../utils/debug.js";
import { warnings } from "../context/messages/index.js";

const debug = createDebugger("stats");

// ============================================================================
// Types
// ============================================================================

export interface StatsParams {
  graph?: boolean;
  context?: boolean;
}

// ============================================================================
// Token Estimates
// ============================================================================

const TOOL_SCHEMA_TOKENS: Record<string, number> = {
  mcx_execute: 800,
  mcx_search: 600,
  mcx_file: 400,

  mcx_find: 300,
  mcx_grep: 300,
  mcx_fetch: 250,
  mcx_stats: 150,
  mcx_tasks: 400,
  mcx_watch: 200,
  mcx_doctor: 100,
  mcx_upgrade: 100,
  mcx_adapter: 300,
};

// ============================================================================
// Handler
// ============================================================================

async function handleStats(
  ctx: ToolContext,
  params: StatsParams
): Promise<McpResult> {
  const { graph = false, context = false } = params;
  const span = debug.span("handleStats", { graph, context });
  const output: string[] = [];
  
  // Header
  output.push("MCX Session Statistics");
  output.push("═".repeat(30));
  output.push("");

  // 1. Content Store
  try {
    const sources = ctx.contentStore.getSources();
    const totalChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0);
    const totalBytes = sources.reduce((sum, s) => sum + (s.totalBytes || 0), 0);
    
    output.push(`📦 Indexed Content`);
    output.push(`   Sources: ${sources.length}`);
    output.push(`   Chunks: ${totalChunks}`);
    output.push(`   Size: ${formatBytes(totalBytes)}`);
    output.push("");
    
    // Top sources
    if (sources.length > 0) {
      const top = sources
        .sort((a, b) => b.chunkCount - a.chunkCount)
        .slice(0, 5);
      output.push("   Top sources:");
      for (const s of top) {
        output.push(`   - ${s.label}: ${s.chunkCount} chunks`);
      }
      output.push("");
    }
  } catch (e) {
    output.push(`📦 Content Store: Error - ${e}`);
    output.push("");
  }

  // 2. Session Variables
  const varSummary = getVariableSummary();
  output.push(`📝 Variables: ${varSummary.length}`);
  if (varSummary.length > 0) {
    for (const v of varSummary.slice(0, 10)) {
      const compressed = v.compressed ? " [compressed]" : "";
      output.push(`   ${v.name}: ${formatBytes(v.size)}${compressed}`);
    }
    if (varSummary.length > 10) {
      output.push(`   ... +${varSummary.length - 10} more`);
    }
  }
  output.push("");

  // 3. Recent Tools
  const recentTools = getRecentTools(10);
  output.push(`🔧 Recent Tools: ${recentTools.length}`);
  if (recentTools.length > 0) {
    const toolCounts = new Map<string, number>();
    for (const t of recentTools) {
      toolCounts.set(t.tool, (toolCounts.get(t.tool) || 0) + 1);
    }
    const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tool, count] of sorted.slice(0, 5)) {
      output.push(`   - ${tool}: ${count} calls`);
    }
  }
  output.push("");

  // 3.5. Top Adapter Methods (Frecency)
  const topMethods = getTopMethods(5);
  if (topMethods.length > 0) {
    output.push(`🔥 Top Methods: ${topMethods.length}`);
    for (const [method, count] of topMethods) {
      output.push(`   - ${method}: ${count} calls`);
    }
    output.push("");
  }

  // 4. Recent Files (Proximity Context)
  const recentFiles = getRecentFiles();
  output.push(`📁 Recent Files: ${recentFiles.length}`);
  if (recentFiles.length > 0) {
    for (const f of recentFiles.slice(0, 5)) {
      output.push(`   - ${f}`);
    }
    if (recentFiles.length > 5) {
      output.push(`   ... +${recentFiles.length - 5} more`);
    }
  }
  output.push("");


  // 5. Session Stats (Context Efficiency, I/O, Cache)
  const stats = getSessionStats();

  // 5a. Context Efficiency (bytes kept in sandbox vs sent to model)
  const keptOut = stats.fsBytesRead + stats.networkBytesIn;
  const totalProcessed = keptOut + stats.totalChars;
  
  if (totalProcessed > 0) {
    const reductionPct = Math.round((keptOut / totalProcessed) * 100);
    
    output.push("📊 Context Efficiency");
    
    if (keptOut > 0) {
      const barWidth = 20;
      const filledKept = Math.round((keptOut / totalProcessed) * barWidth);
      output.push(`   Processed: |${"█".repeat(barWidth)}| ${formatBytes(totalProcessed)}`);
      output.push(`   To Model:  |${"█".repeat(barWidth - filledKept)}${"░".repeat(filledKept)}| ${formatBytes(stats.totalChars)} (${100 - reductionPct}%)`);
      output.push("");

      // Token savings
      const tokensSaved = Math.round(keptOut / 4);
      const contextWindow = 200000;
      const pctPreserved = ((tokensSaved / contextWindow) * 100).toFixed(1);
      output.push(`   🎯 ${formatBytes(keptOut)} kept in sandbox (${reductionPct}% reduction)`);
      output.push(`      -> ${tokensSaved.toLocaleString()} tokens preserved (${pctPreserved}% of context)`);

      // Cost avoided (Opus pricing ~$5/1M input tokens)
      const costSaved = (tokensSaved / 1000000 * 5).toFixed(3);
      if (parseFloat(costSaved) >= 0.01) {
        output.push(`      -> $${costSaved} context cost avoided`);
      }
    } else {
      output.push(`   ${formatBytes(stats.totalChars)} sent to model (no sandbox data yet)`);
      output.push(`   ${formatBytes(stats.totalChars)} in ${stats.totalCalls} calls`);
    }
    output.push("");

    // Tool breakdown table
    if (stats.byTool.length > 0) {
      output.push("┌──────────────┬───────┬──────────┬─────────┐");
      output.push("│ Tool         │ Calls │ Bytes    │ Saved   │");
      output.push("├──────────────┼───────┼──────────┼─────────┤");

      const sorted = [...stats.byTool].sort((a, b) => b[1].chars - a[1].chars).slice(0, 8);
      for (const [tool, s] of sorted) {
        const name = tool.replace("mcx_", "").padEnd(12);
        const calls = String(s.calls).padStart(5);
        const bytes = formatBytes(s.chars).padStart(8);
        const pct = s.raw > s.chars ? `${Math.round(((s.raw - s.chars) / s.raw) * 100)}%` : "";
        output.push(`│ ${name} │ ${calls} │ ${bytes} │ ${pct.padStart(7)} │`);
      }
      output.push("└──────────────┴───────┴──────────┴─────────┘");
      output.push("");
    }
  }

  // 5b. I/O Statistics
  if (stats.fsBytesRead > 0 || stats.networkBytesIn > 0) {
    output.push("📁 I/O Stats");
    if (stats.fsBytesRead > 0) {
      output.push(`   FS: ${formatBytes(stats.fsBytesRead)} (${stats.fsFilesRead} files)`);
    }
    if (stats.networkBytesIn > 0) {
      output.push(`   Network: ${formatBytes(stats.networkBytesIn)} (${stats.networkRequests} requests)`);
    }
    output.push("");
  }

  // 5c. Cache Statistics
  if (stats.cacheHits > 0) {
    output.push(`💾 Cache: ${stats.cacheHits} hits (${formatBytes(stats.cacheBytesSaved)} saved)`);
    output.push("");
  }

  // 5d. Stored Variables
  if (stats.storedVarsCount > 0) {
    output.push(`📦 Variables: ${stats.storedVarsCount} stored (${formatBytes(stats.storedVarsBytes)})`);
    output.push("");
  }

  // 6. Worker Pool (if available and has workers)
  if (ctx.sandbox && typeof (ctx.sandbox as any).getPoolStats === "function") {
    try {
      const poolStats = (ctx.sandbox as any).getPoolStats();
      if (poolStats && typeof poolStats.total === 'number' && poolStats.total > 0) {
        const idle = poolStats.idle ?? 0;
        output.push(`⚙️ Worker Pool`);
        output.push(`   Total: ${poolStats.total}`);
        output.push(`   Idle: ${idle}`);
        output.push(`   Busy: ${poolStats.total - idle}`);
        output.push("");
      }
    } catch {
      // Pool stats not available
    }
  }

  // 7. Watched Projects
  if (ctx.watchedProjects.size > 0) {
    output.push(`👁️ Watched Projects: ${ctx.watchedProjects.size}`);
    for (const path of ctx.watchedProjects.keys()) {
      output.push(`   - ${path}`);
    }
    output.push("");
  }

  // 7. Graph view (if requested)
  if (graph && recentTools.length > 0) {
    output.push("📊 Tool Usage Graph");
    output.push("");
    
    const toolCounts = new Map<string, number>();
    for (const t of recentTools) {
      toolCounts.set(t.tool, (toolCounts.get(t.tool) || 0) + 1);
    }
    
    const maxCount = Math.max(...toolCounts.values());
    const barWidth = 20;
    
    const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tool, count] of sorted) {
      const name = tool.replace("mcx_", "").padEnd(10);
      const filled = Math.round((count / maxCount) * barWidth);
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
      output.push(`   ${name} ${bar} ${count}`);
    }
    output.push("");
  }

  // 9. Context estimate (if requested)
  if (context) {
    output.push("📏 Context Estimate");
    
    // Schema tokens
    const loadedTools = Object.keys(TOOL_SCHEMA_TOKENS);
    const schemaTokens = loadedTools.reduce((sum, t) => sum + (TOOL_SCHEMA_TOKENS[t] || 150), 0);
    
    // Variable tokens (rough estimate: size / 4)
    const varTokens = vars.reduce((sum, v) => sum + Math.round(v.size / 4), 0);
    
    const totalTokens = schemaTokens + varTokens;
    const contextWindow = 200000;
    const pctUsed = ((totalTokens / contextWindow) * 100).toFixed(1);
    
    output.push(`   Schema: ~${schemaTokens} tokens`);
    output.push(`   Variables: ~${varTokens} tokens`);
    output.push(`   Total: ~${totalTokens} tokens (${pctUsed}% of 200K)`);
    output.push("");
  }

  span.end({ sections: output.length });
  return output.join("\n");
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxStats: ToolDefinition<StatsParams> = {
  name: "mcx_stats",
  description: "Session statistics: indexed content, searches, executions, variables. Use graph:true for visual bar charts.",
  inputSchema: {
    type: "object",
    properties: {
      graph: {
        type: "boolean",
        description: "Show ASCII bar charts for tool usage",
        default: false,
      },
      context: {
        type: "boolean",
        description: "Show context contribution estimates (schema resolution)",
        default: false,
      },
    },
  },
  handler: handleStats,
};

// ============================================================================
// Raw Data Detection (for token efficiency warnings)
// ============================================================================

const RAW_DATA_THRESHOLD = 10_000;

/** Detect if first item has a field matching pattern */
function hasField(keys: string[], pattern: string): boolean {
  return keys.some(k => k.toLowerCase().includes(pattern));
}

/** Build suggestion for array data based on detected fields */
function buildArraySuggestion(keys: string[], _length: number): string[] {
  const suggestions: string[] = [];
  
  const idKey = keys.find(k => k.toLowerCase().includes('id'));
  const nameKey = keys.find(k => k.toLowerCase().includes('name') || k.toLowerCase().includes('title'));
  
  if (idKey && nameKey) {
    suggestions.push(`pick($result, ['${idKey}', '${nameKey}'])`);
  }
  if (hasField(keys, 'status') || hasField(keys, 'state')) {
    suggestions.push(`$result.filter(x => x.status === "active")`);
  }
  if (suggestions.length === 0) {
    suggestions.push(`pick($result, ['${keys.slice(0, 2).join("', '")}'])`);
  }
  
  return suggestions;
}

/**
 * Detect raw data and suggest processing.
 * Returns warning message if large data detected, null otherwise.
 */
export function detectRawData(value: unknown, serializedLength: number): string | null {
  if (serializedLength < RAW_DATA_THRESHOLD) return null;
  
  // Large array
  if (Array.isArray(value) && value.length > 20) {
    const first = value[0];
    if (first && typeof first === 'object') {
      const keys = Object.keys(first);
      const suggestions = buildArraySuggestion(keys, value.length);
      return warnings.largeArray(value.length, Math.round(serializedLength/1024), suggestions);
    }
  }
  
  // Large object
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length > 20) {
      const suggestions = [
        `$result.${keys[0]} — access specific key`,
        `pick($result, ['${keys.slice(0, 3).join("', '")}'])`
      ];
      return warnings.largeObject(keys.length, Math.round(serializedLength/1024), suggestions);
    }
  }
  
  return null;
}

export default mcxStats;
