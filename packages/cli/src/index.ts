import { Command } from "commander";
import pc from "picocolors";
import * as path from "path";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { listCommand } from "./commands/list.js";
import { genCommand } from "./commands/gen.js";
import { updateCommand } from "./commands/update.js";

const program = new Command();

program
  .name("mcx")
  .description("MCX - Modular Code Execution framework for AI agents")
  .version("0.1.4");

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
  .description("Update MCX CLI and project dependencies")
  .option("-c, --cli", "Update CLI only")
  .option("-p, --project", "Update project dependencies only")
  .option("--check", "Check versions without updating")
  .action(async (options: { cli?: boolean; project?: boolean; check?: boolean }) => {
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
