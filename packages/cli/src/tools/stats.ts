/**
 * mcx_stats Tool
 * 
 * Session statistics: indexed content, variables, tool usage.
 */

import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatToolResult, formatBytes } from "./utils.js";
import { getVariableSummary } from "../context/variables.js";
import { getRecentTools, getRecentFiles } from "../context/tracking.js";

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
  mcx_edit: 350,
  mcx_find: 300,
  mcx_grep: 300,
  mcx_fetch: 250,
  mcx_write: 200,
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
  const vars = getVariableSummary();
  output.push(`📝 Variables: ${vars.length}`);
  if (vars.length > 0) {
    for (const v of vars.slice(0, 10)) {
      const sizeStr = formatBytes(v.size);
      const typeIcon = v.type === "file" ? "📄" : v.type === "search" ? "🔍" : "📊";
      output.push(`   ${typeIcon} ${v.name}: ${sizeStr}${v.lineCount ? ` (${v.lineCount} lines)` : ""}`);
    }
    if (vars.length > 10) {
      output.push(`   ... +${vars.length - 10} more`);
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

  // 5. Worker Pool (if available)
  if (ctx.sandbox && typeof (ctx.sandbox as any).getPoolStats === "function") {
    try {
      const poolStats = (ctx.sandbox as any).getPoolStats();
      output.push(`⚙️ Worker Pool`);
      output.push(`   Total: ${poolStats.total}`);
      output.push(`   Idle: ${poolStats.idle}`);
      output.push(`   Busy: ${poolStats.total - poolStats.idle}`);
      output.push("");
    } catch {
      // Pool stats not available
    }
  }

  // 6. Watched Projects
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

  // 8. Context estimate (if requested)
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

  return formatToolResult(output.join("\n"));
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxStats: ToolDefinition<StatsParams> = {
  name: "mcx_stats",
  title: "Session Statistics",
  description: "Session statistics: indexed content, searches, executions, variables. Use graph:true for visual bar charts.",
  parameters: {
    graph: {
      type: "boolean",
      description: "Show ASCII bar charts for tool usage",
      default: false,
    },
    context: {
      type: "boolean",
      description: "Show context contribution estimates (schema + results)",
      default: false,
    },
  },
  handler: handleStats,
};

export default mcxStats;
