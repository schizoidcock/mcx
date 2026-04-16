/**
 * Stdio Transport for MCP Server
 *
 * Runs MCP server over stdio for direct Claude connections.
 * Owner runs with frecency ENABLED, proxies connect to HTTP daemon.
 *
 * Linus principles:
 * - Early return for proxy case
 * - Max 3 indent levels
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pc from "picocolors";
import { ensureDaemon, runAsProxy } from "../daemon/client.js";
import { createMcxServer, loadEnvFile } from "./factory.js";
import { logger } from "../utils/logger.js";

// ============================================================================
// Stdio Server
// ============================================================================

export async function runStdio(fffSearchPath?: string): Promise<void> {
  // Check if daemon already running
  const conn = await ensureDaemon();

  // Early return: proxy to existing daemon
  if (!conn.isOwner) {
    await runAsProxy(conn.port);
    return;
  }

  // Owner: run stdio server with frecency ENABLED
  await loadEnvFile();
  console.error(pc.cyan("Starting MCX MCP server (stdio)...\n"));

  const { server, cleanup } = await createMcxServer(fffSearchPath);
  const transport = new StdioServerTransport();

  transport.onerror = (error) => {
    console.error(pc.red("[MCX] Transport error:"), error);
    logger.error("Transport error", error);
  };

  process.stdin.on("close", () => {
    cleanup();
    console.error(pc.dim("[MCX] stdin closed, exiting gracefully"));
    logger.shutdown("stdin closed");
    process.exit(0);
  });

  process.stdin.on("error", (error) => {
    console.error(pc.red("[MCX] stdin error:"), error);
    logger.error("stdin error", error);
  });

  await server.connect(transport);

  const pkg = await import("../../package.json");
  logger.startup(pkg.version, "stdio");

  console.error(pc.green("MCX MCP server running"));
  console.error(pc.dim(`HTTP daemon on port ${conn.port} for other sessions`));
}
