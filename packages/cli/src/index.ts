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

const CLI_PACKAGE = "@papicandela/mcx-cli";
const CURRENT_VERSION = "0.1.10";
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
        shell: true,
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
        shell: true,
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
autoUpdate();

const program = new Command();

program
  .name("mcx")
  .description("MCX - Modular Code Execution framework for AI agents")
  .version(CURRENT_VERSION);

program
  .command("init")
  .description("Initialize a new MCX project in the current directory")
  .action(async () => {
    try {
      await initCommand();
    } catch (error) {
      console.error(pc.red("Init failed:"), error);
      process.exit(1);
    }
  });

program
  .command("run <target>")
  .description("Run a script file or skill")
  .argument("[args...]", "Arguments to pass to the skill (key=value format)")
  .action(async (target: string, args: string[]) => {
    try {
      await runCommand(target, args);
    } catch (error) {
      console.error(pc.red("Run failed:"), error);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Start the MCP server for Claude Code integration")
  .option("-t, --transport <type>", "Transport type: stdio (default) or http", "stdio")
  .option("-p, --port <number>", "HTTP port (only for http transport)", "3100")
  .option("-c, --cwd <path>", "Working directory for config and adapters")
  .action(async (options: { transport: string; port: string; cwd?: string }) => {
    try {
      await serveCommand({
        transport: options.transport as "stdio" | "http",
        port: parseInt(options.port, 10),
        cwd: options.cwd,
      });
    } catch (error) {
      console.error(pc.red("Serve failed:"), error);
      process.exit(1);
    }
  });

program
  .command("list")
  .alias("ls")
  .description("List available skills and adapters")
  .action(async () => {
    try {
      await listCommand();
    } catch (error) {
      console.error(pc.red("List failed:"), error);
      process.exit(1);
    }
  });

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
  .action(async (source: string | undefined, options: { output?: string; name?: string; baseUrl?: string; auth?: string; readOnly?: boolean; include?: string; exclude?: string }) => {
    try {
      await genCommand({
        source,
        output: options.output,
        name: options.name,
        baseUrl: options.baseUrl,
        auth: options.auth,
        readOnly: options.readOnly,
        include: options.include,
        exclude: options.exclude,
        interactive: !source, // Interactive mode if no source provided
      });
    } catch (error) {
      console.error(pc.red("Gen failed:"), error);
      process.exit(1);
    }
  });

program
  .command("update")
  .alias("upgrade")
  .description("Update MCX CLI and global installation")
  .option("-c, --cli", "Update CLI only")
  .option("-g, --global", "Clean and update global ~/.mcx/ installation only")
  .option("-p, --project", "Update project dependencies only (legacy)")
  .option("--check", "Check versions without updating")
  .action(async (options: { cli?: boolean; global?: boolean; project?: boolean; check?: boolean }) => {
    try {
      await updateCommand(options);
    } catch (error) {
      console.error(pc.red("Update failed:"), error);
      process.exit(1);
    }
  });

// Default to serve if no command provided
if (process.argv.length === 2) {
  serveCommand({ transport: "stdio" }).catch((error) => {
    console.error(pc.red("Serve failed:"), error);
    process.exit(1);
  });
} else {
  program.parse();
}
