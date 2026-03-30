import { Command } from "commander";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";
import * as path from "path";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { listCommand } from "./commands/list.js";
import { genCommand } from "./commands/gen.js";
import { updateCommand } from "./commands/update.js";
import { logsCommand } from "./commands/logs.js";
import { logger } from "./utils/logger.js";

// ============================================================================
// Global Error Handlers (prevent silent crashes)
// ============================================================================

process.on("uncaughtException", (error) => {
  console.error(pc.red("[MCX] Uncaught exception:"), error);
  logger.uncaughtException(error);
  // Don't exit - try to keep the server running
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(pc.red("[MCX] Unhandled rejection at:"), promise);
  console.error(pc.red("[MCX] Reason:"), reason);
  logger.unhandledRejection(reason);
  // Don't exit - try to keep the server running
});

// Note: No "exit" handler - it's sync-only and async logger won't complete.
// SIGINT/SIGTERM handlers below log shutdown before exiting.

process.on("SIGINT", () => {
  logger.shutdown("SIGINT").finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  logger.shutdown("SIGTERM").finally(() => process.exit(0));
});

const CLI_PACKAGE = "@papicandela/mcx-cli";

// Read version from package.json at build time (injected by bundler)
// Fallback to reading at runtime if not available
import packageJson from "../package.json";
const CURRENT_VERSION = packageJson.version;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ============================================================================
// Command Error Handler
// ============================================================================

/** Wrap command action with consistent error handling */
function handleCommand<T extends unknown[]>(
  name: string,
  fn: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(pc.red(`${name} failed:`), error);
      process.exit(1);
    }
  };
}

async function autoUpdate(): Promise<void> {
  try {
    const mcxDir = join(homedir(), ".mcx");
    const checkFile = join(mcxDir, ".last-update-check");

    // Check if we should run (throttle to once per hour)
    try {
      const lastCheck = await readFile(checkFile, "utf-8");
      const lastTime = parseInt(lastCheck, 10);
      if (Date.now() - lastTime < CHECK_INTERVAL_MS) return;
    } catch {}

    // Get latest version from npm
    const latest = await new Promise<string | null>((resolve) => {
      const proc = spawn("npm", ["view", CLI_PACKAGE, "version"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      proc.stdout?.on("data", (d) => (output += d.toString()));
      proc.on("close", (code) => resolve(code === 0 ? output.trim() : null));
      proc.on("error", () => resolve(null));
      setTimeout(() => { proc.kill(); resolve(null); }, 3000);
    });

    if (!latest || latest === CURRENT_VERSION) {
      // Save check timestamp
      await mkdir(mcxDir, { recursive: true });
      await writeFile(checkFile, Date.now().toString());
      return;
    }

    // Auto-update silently
    console.error(pc.cyan(`Updating MCX CLI: ${CURRENT_VERSION} → ${latest}...`));
    await new Promise<void>((resolve) => {
      const proc = spawn("bun", ["install", "-g", `${CLI_PACKAGE}@latest`], {
        stdio: "inherit",
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });

    // Save check timestamp
    await mkdir(mcxDir, { recursive: true });
    await writeFile(checkFile, Date.now().toString());
    console.error(pc.green(`Updated to ${latest}`));
  } catch {
    // Silently fail - don't block CLI usage
  }
}

// Run auto-update check in background (non-blocking)
// SECURITY: Explicitly catch to prevent unhandled rejection crash
autoUpdate().catch(() => {});

const program = new Command();

program
  .name("mcx")
  .description("MCX - Modular Code Execution framework for AI agents")
  .version(CURRENT_VERSION);

program
  .command("init")
  .description("Initialize a new MCX project in the current directory")
  .action(handleCommand("Init", initCommand));

program
  .command("run <target>")
  .description("Run a script file or skill")
  .argument("[args...]", "Arguments to pass to the skill (key=value format)")
  .action(handleCommand("Run", runCommand));

program
  .command("serve")
  .description("Start the MCP server for Claude Code integration")
  .option("-t, --transport <type>", "Transport type: stdio (default) or http", "stdio")
  .option("-p, --port <number>", "HTTP port (only for http transport)", "3100")
  .option("-c, --cwd <path>", "Working directory for config and adapters")
  .action(handleCommand("Serve", async (options: { transport: string; port: string; cwd?: string }) => {
    await serveCommand({
      transport: options.transport as "stdio" | "http",
      port: parseInt(options.port, 10),
      cwd: options.cwd,
    });
  }));

program
  .command("list")
  .alias("ls")
  .description("List available skills and adapters")
  .action(handleCommand("List", listCommand));

program
  .command("gen")
  .alias("generate-adapter")
  .description("Generate adapter from OpenAPI specs in Markdown files")
  .argument("[source]", "Source directory or file with markdown docs (interactive if omitted)")
  .option("-o, --output <path>", "Output file path")
  .option("-n, --name <name>", "Adapter name")
  .option("-b, --base-url <url>", "Base URL for the API")
  .option("-a, --auth <type>", "Auth type: basic, bearer, apikey, none (default: basic)")
  .option("--read-only", "Only generate GET methods")
  .option("--include <patterns>", "Include only endpoints matching patterns (comma-separated)")
  .option("--exclude <patterns>", "Exclude endpoints matching patterns (comma-separated)")
  .action(handleCommand("Gen", async (source: string | undefined, options: { output?: string; name?: string; baseUrl?: string; auth?: string; readOnly?: boolean; include?: string; exclude?: string }) => {
    await genCommand({
      source,
      output: options.output,
      name: options.name,
      baseUrl: options.baseUrl,
      auth: options.auth,
      readOnly: options.readOnly,
      include: options.include,
      exclude: options.exclude,
      // Don't auto-set interactive - let genCommand try discovery first
    });
  }));

program
  .command("update")
  .alias("upgrade")
  .description("Update MCX CLI and global installation")
  .option("-c, --cli", "Update CLI only")
  .option("-g, --global", "Clean and update global ~/.mcx/ installation only")
  .option("-p, --project", "Update project dependencies only (legacy)")
  .option("--check", "Check versions without updating")
  .action(handleCommand("Update", updateCommand));

program
  .command("logs")
  .description("View MCX server logs")
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output (like tail -f)")
  .option("--clear", "Clear all log files")
  .action(handleCommand("Logs", async (options: { lines: string; follow?: boolean; clear?: boolean }) => {
    await logsCommand({
      lines: parseInt(options.lines, 10),
      follow: options.follow,
      clear: options.clear,
    });
  }));

// Default to serve if no command provided
if (process.argv.length === 2) {
  serveCommand({ transport: "stdio" }).catch((error) => {
    console.error(pc.red("Serve failed:"), error);
    process.exit(1);
  });
} else {
  program.parse();
}
