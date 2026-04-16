/**
   * Daemon Client
   *
   * Owner: runs stdio server + HTTP daemon
   * Non-owner: proxies to HTTP daemon
   *
   * Linus principles: no special cases, early returns, max 3 indent levels
   */

  import pc from "picocolors";
  import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { z } from "zod";
  import { readLock, writeLock, deleteLock, isDaemonAlive } from "./lock.js";
  import { startDaemonServer } from "../server/index.js";
  import type { DaemonConnection } from "./types.js";

  // ============================================================================
  // Entry Point - No special cases
  // ============================================================================

  export async function ensureDaemon(port: number = 3100): Promise<DaemonConnection> {
    const lock = readLock();
    const alive = lock && (await isDaemonAlive(lock));

    // Early return: daemon exists
    if (alive) return { port: lock.port, isOwner: false };

    // Clean stale lock and start daemon
    if (lock) deleteLock();
    return startAsDaemon(port);
  }

  // ============================================================================
  // Daemon Startup
  // ============================================================================

  async function startAsDaemon(port: number): Promise<DaemonConnection> {
    const actualPort = await startDaemonServer(port);
    writeLock({ pid: process.pid, port: actualPort, startedAt: Date.now() });
    return { port: actualPort, isOwner: true };
  }

  // ============================================================================
  // Proxy - Uses SDK StdioServerTransport
  // ============================================================================

export async function runAsProxy(port: number): Promise<void> {
  console.error(pc.dim(`[mcx] Connecting to daemon on port ${port}...`));

  const health = await fetchDaemonHealth(port);
  if (!health) throw new Error("Daemon not responding");

  const tools = await fetchDaemonTools(port);
  const server = createProxyServer(port, tools);
  const transport = new StdioServerTransport();

  startHeartbeat(port, health.sessionId);
  await server.connect(transport);
  console.error(pc.dim(`[mcx] Proxy ready (${tools.length} tools, session: ${health.sessionId.slice(0, 8)})`));
}

/** Heartbeat: verify daemon alive AND same session (Linus: early returns) */
function startHeartbeat(port: number, expectedSessionId: string): void {
  const check = async () => {
    const health = await fetchDaemonHealth(port);
    if (!health) return exitProxy("Daemon died");
    if (health.sessionId !== expectedSessionId) return exitProxy("Daemon restarted");
  };
  setInterval(check, 3000);
}

function exitProxy(reason: string): void {
  console.error(pc.dim(`[mcx] ${reason}, closing proxy`));
  process.exit(0);
}

  // ============================================================================
  // Helpers - Small, focused functions
  // ============================================================================

  async function fetchDaemonTools(port: number): Promise<any[]> {
    await callDaemon(port, {
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcx-proxy", version: "1.0.0" },
      },
      id: "init-1",
    });

    const response = await callDaemon(port, {
      jsonrpc: "2.0",
      method: "tools/list",
      id: "init-2",
    });
    return (response as any)?.result?.tools || [];
  }

  function createProxyServer(port: number, tools: any[]): McpServer {
    const server = new McpServer({ name: "mcx-proxy", version: "0.1.0" });
    for (const tool of tools) registerProxyTool(server, port, tool);
    return server;
  }

  function registerProxyTool(server: McpServer, port: number, tool: any): void {
    server.registerTool(
      tool.name,
      {
        description: tool.description || tool.name,
        inputSchema: z.object({}).passthrough(),
      },
      async (params) => forwardToolCall(port, tool.name, params)
    );
  }

  async function forwardToolCall(port: number, name: string, params: unknown): Promise<any> {
    const response = await callDaemon(port, {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: params },
      id: `call-${Date.now()}`,
    });
    return (response as any)?.result || { content: [{ type: "text", text: "No response" }] };
  }

  async function callDaemon(port: number, body: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream"
    },
    body: JSON.stringify(body),
  });
  return response.json();
}

interface DaemonHealth {
  status: string;
  sessionId: string;
  uptime: number;
}

/** Fetch daemon health (returns null if unreachable) */
async function fetchDaemonHealth(port: number): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
