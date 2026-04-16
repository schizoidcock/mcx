/**
 * HTTP Transport for MCP Server
 *
 * Two modes:
 * - startDaemonServer: Node createServer for daemon/proxy (frecency disabled)
 * - runHttp: Bun.serve for standalone HTTP mode
 *
 * Linus principles:
 * - Max 3 indent levels, early returns
 * - One server instance, reused transport
 */

import * as path from "node:path";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pc from "picocolors";
import { deleteLock } from "../daemon/lock.js";
import { createMcxServer, loadEnvFile, loadConfig, loadSkills } from "./factory.js";
import { createMcxServerCore } from "./core.js";
import { getMcxHomeDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

const startTime = Date.now();
const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Mutex for daemon MCP requests (prevents concurrent connect() calls)
let daemonLock: Promise<void> = Promise.resolve();

/** Acquire mutex, returns release function */
function acquireLock(): Promise<() => void> {
  let release: () => void;
  const prev = daemonLock;
  daemonLock = new Promise(r => { release = r; });
  return prev.then(() => release!);
}

// ============================================================================
// Standalone HTTP Mode (Bun.serve)
// ============================================================================

export async function runHttp(port: number, fffSearchPath?: string) {
  const transport = await initHttpServer(port, fffSearchPath);
  startBunServer(port, transport);
}

async function initHttpServer(port: number, fffSearchPath?: string) {
  await loadEnvFile();
  console.error(pc.cyan(`Starting MCX MCP server (HTTP:${port})...\n`));

  const config = await loadConfig();
  const skills = await loadSkills();
  const adapters = config?.adapters || [];
  console.error(pc.dim(`Loaded ${adapters.length} adapter(s), ${skills.size} skill(s)`));

  const { server, cleanup } = await createMcxServerCore(config, adapters, skills, fffSearchPath);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  registerShutdownHandlers(cleanup);
  console.error(pc.dim("MCP server and transport initialized"));

  const pkg = await import("../../package.json");
  logger.startup(pkg.version, `http:${port}`);

  return transport;
}

function startBunServer(port: number, transport: StreamableHTTPServerTransport) {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (req) => handleHttpRequest(req, transport),
  });
  console.error(pc.green(`MCX MCP server running on http://127.0.0.1:${port}/mcp`));
  console.error(pc.dim("Health: GET /health"));
}

function handleHttpRequest(req: Request, transport: StreamableHTTPServerTransport): Response | Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok", server: "mcx-mcp-server", version: "0.1.0" });
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    return handleMcpPost(req, transport);
  }

  return new Response("Not Found", { status: 404 });
}

async function handleMcpPost(req: Request, transport: StreamableHTTPServerTransport): Promise<Response> {
  try {
    const body = await req.json();
    const result = await transport.handleRequest(req, body);
    return Response.json(result);
  } catch (error) {
    console.error("MCP request error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
function registerShutdownHandlers(cleanup: () => void): void {
  const debugLog = (msg: string) => {
    const fs = require("fs");
    const logPath = path.join(getMcxHomeDir(), "logs", "debug.log");
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  };

  process.on("SIGINT", () => { debugLog("SIGINT"); cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { debugLog("SIGTERM"); cleanup(); process.exit(0); });
  process.on("SIGHUP", () => { debugLog("SIGHUP"); cleanup(); process.exit(0); });
  process.on("beforeExit", (code) => { debugLog(`beforeExit code=${code}`); });
  process.on("exit", (code) => { debugLog(`exit code=${code}`); });
}

// ============================================================================
// Daemon HTTP Mode (Node createServer, frecency disabled)
// ============================================================================

export async function startDaemonServer(port: number = 3100): Promise<number> {
  const { server, cleanup } = await createMcxServer(undefined, true);
  const httpServer = createServer((req, res) => handleDaemonRequest(req, res, server));

  registerDaemonCleanup(cleanup);

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      console.error(pc.dim(`[mcx] HTTP daemon on port ${port}`));
      resolve(port);
    });
  });
}

async function handleDaemonRequest(req: any, res: any, server: any): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", sessionId, uptime: Date.now() - startTime }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    await handleDaemonMcpRequest(req, res, server);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

async function handleDaemonMcpRequest(req: any, res: any, server: any): Promise<void> {
  let body = "";
  for await (const chunk of req) body += chunk;

  const release = await acquireLock();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
    release();
  }
}

function registerDaemonCleanup(serverCleanup: () => void): void {
  const cleanup = () => {
    deleteLock();
    serverCleanup();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}
