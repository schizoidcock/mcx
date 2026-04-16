/**
 * MCP Server Core
 *
 * Linus principles:
 * - Orchestration only (<100 lines)
 * - Delegates to state.ts and finder.ts
 * - No internal functions (all extracted)
 */

import pc from "picocolors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BunWorkerSandbox } from "@papicandela/mcx-core";

// Types
import type { Skill, Adapter, MCXConfig } from "./factory.js";
import { buildAdapterContext } from "./factory.js";

// State management
import { createServerState, trackTokenOutput } from "../context/state.js";

// Finder management  
import { createFinderCache, withFinder, destroyFinderCache } from "../utils/finder.js";

// Context
import { createToolContext, FILE_HELPERS_CODE } from "../context/create.js";

// Search
import { getContentStore } from "../search/index.js";

// Tools
import { registerExtractedTools } from "../tools/register.js";

// Daemon
import { stopDaemon } from "../daemon/index.js";

// Specs
import { loadSpecsFromAdapters } from "../spec/index.js";

// ============================================================================
// Core Server Creation
// ============================================================================

export async function createMcxServerCore(
  config: MCXConfig | null,
  adapters: Adapter[],
  skills: Map<string, Skill>,
  fffSearchPath?: string,
  disableFrecency?: boolean
) {
  // 1. Cleanup stale FTS5 data
  cleanupStaleContent();

  // 2. Create sandbox
  const sandbox = new BunWorkerSandbox({
    timeout: config?.sandbox?.timeout ?? 30000,
    memoryLimit: config?.sandbox?.memoryLimit ?? 128,
    allowAsync: true,
  });

  // 3. Initialize state and finder
  const state = createServerState();
  const basePath = fffSearchPath || process.cwd();
  const finderCache = await createFinderCache(basePath, disableFrecency);

  // 4. Build contexts
  const adapterContext = buildAdapterContext(adapters);
  const cachedSpec = loadSpecsFromAdapters(adapters);

  // 5. Create MCP server with tracking wrapper
  const server = new McpServer({ name: "mcx-mcp-server", version: "0.1.0" });
  wrapServerWithTracking(server, state);

  // 6. Create tool context and register tools
  const toolContext = await createToolContext({
    basePath,
    spec: cachedSpec,
    sandbox,
    cleanupOnStart: false,
    adapterContext,
  });

  registerExtractedTools({
    server,
    ctx: toolContext,
    skills,
    withFinder: (path, fn) => withFinder(finderCache, path, fn),
  });

  return {
    server,
    cleanup: () => {
      stopDaemon();
      destroyFinderCache(finderCache);
    },
  };
}

// ============================================================================
// Helpers (small, focused)
// ============================================================================

function cleanupStaleContent(): void {
  try {
    const store = getContentStore();
    const cleaned = store.cleanupStale(24 * 60 * 60 * 1000);
    if (cleaned > 0) console.error(pc.dim(`Cleaned up ${cleaned} stale source(s)`));
  } catch {
    // Ignore cleanup errors
  }
}

function wrapServerWithTracking(server: McpServer, state: ReturnType<typeof createServerState>): void {
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: any, handler: any) => {
    const tracked = async (params: any) => {
      const result = await handler(params);
      const rawBytes = (result as any)._rawBytes;
      if (rawBytes !== undefined) delete (result as any)._rawBytes;
      return trackTokenOutput(state, name, result, rawBytes);
    };
    return original(name, config, tracked);
  }) as typeof server.registerTool;
}
