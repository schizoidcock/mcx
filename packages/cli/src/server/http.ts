/**
 * HTTP Transport for MCP Server (Bun.serve)
 *
 * Standalone HTTP mode for direct connections.
 * Each session runs its own server process.
 *
 * Linus principles:
 * - One server, one transport, one connect
 * - Max 3 indent levels, early returns
 */

import * as path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pc from "picocolors";
import { loadEnvFile, loadConfig, loadSkills } from "./factory.js";
import { createMcxServerCore } from "./core.js";
import { getMcxHomeDir } from "../utils/paths.js";
import { logger } from "../utils/logger.js";

import { createDebugger, reloadDebugConfig } from "../utils/debug.js";

const debug = createDebugger("http");

// ============================================================================
// HTTP Mode (Bun.serve)
// ============================================================================

export async function runHttp(port: number, fffSearchPath?: string) {
  const transport = await initHttpServer(port, fffSearchPath);
  startBunServer(port, transport);
}

async function initHttpServer(port: number, fffSearchPath?: string) {
  await loadEnvFile();
  reloadDebugConfig();
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
    fetch: (req) => handleHttpRequest(req, transport),
  });
  console.error(pc.green(`MCX MCP server running on http://localhost:${port}`));
}

function handleHttpRequest(req: Request, transport: StreamableHTTPServerTransport): Response | Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health") {
    return Response.json({ status: "ok" });
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
    const fs = require("node:fs");
    const logPath = path.join(getMcxHomeDir(), "logs", "debug.log");
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  };

  process.on("SIGINT", () => { debugLog("SIGINT"); cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { debugLog("SIGTERM"); cleanup(); process.exit(0); });
  process.on("SIGHUP", () => { debugLog("SIGHUP"); cleanup(); process.exit(0); });
  process.on("beforeExit", (code) => { debugLog(`beforeExit code=${code}`); });
  process.on("exit", (code) => { debugLog(`exit code=${code}`); });
}