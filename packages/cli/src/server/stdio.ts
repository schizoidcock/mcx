/**
 * Stdio Transport for MCP Server
 *
 * Each Claude session runs its own server process.
 * No daemon, no proxy — one server per session.
 *
 * Linus principles:
 * - One server, one transport, one connect
 * - Functions 10-15 lines, max 3 indent
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pc from "picocolors";
import { createMcxServer, loadEnvFile } from "./factory.js";
import { logger } from "../utils/logger.js";

export async function runStdio(fffSearchPath?: string): Promise<void> {
  await loadEnvFile();
  console.error(pc.cyan("Starting MCX MCP server (stdio)...\n"));

  const { server, cleanup } = await createMcxServer(fffSearchPath);
  const transport = new StdioServerTransport();

  setupHandlers(transport, cleanup);
  await server.connect(transport);

  const pkg = await import("../../package.json");
  logger.startup(pkg.version, "stdio");
  console.error(pc.green("MCX MCP server running"));
}

function setupHandlers(transport: StdioServerTransport, cleanup: () => void): void {
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
}