/**
 * MCX Logs Command
 * View and manage MCX log files
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import pc from "picocolors";

const LOG_DIR = join(homedir(), ".mcx", "logs");
const LOG_FILE = join(LOG_DIR, "mcx.log");

export interface LogsOptions {
  lines?: number;
  follow?: boolean;
  clear?: boolean;
}

export async function logsCommand(options: LogsOptions = {}): Promise<void> {
  const lines = options.lines ?? 50;

  if (options.clear) {
    const { unlink } = await import("node:fs/promises");
    try {
      const files = await readdir(LOG_DIR);
      for (const file of files) {
        if (file.startsWith("mcx.log")) {
          await unlink(join(LOG_DIR, file));
        }
      }
      console.log(pc.green("Logs cleared"));
    } catch {
      console.log(pc.yellow("No logs to clear"));
    }
    return;
  }

  try {
    const content = await readFile(LOG_FILE, "utf-8");
    const allLines = content.trim().split("\n");
    const lastLines = allLines.slice(-lines);

    console.log(pc.dim(`=== ${LOG_FILE} (last ${lines} lines) ===\n`));

    for (const line of lastLines) {
      // Color-code by log level
      if (line.includes("[ERROR]")) {
        console.log(pc.red(line));
      } else if (line.includes("[WARN]")) {
        console.log(pc.yellow(line));
      } else if (line.includes("[INFO]")) {
        console.log(pc.cyan(line));
      } else if (line.includes("[DEBUG]")) {
        console.log(pc.dim(line));
      } else {
        // Stack trace or continuation lines
        console.log(pc.dim(line));
      }
    }

    if (allLines.length > lines) {
      console.log(pc.dim(`\n... ${allLines.length - lines} earlier lines not shown`));
    }

    // Show log file stats
    const stats = await stat(LOG_FILE);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(pc.dim(`\nLog size: ${sizeKB} KB`));

    if (options.follow) {
      console.log(pc.dim("\nFollowing logs (Ctrl+C to stop)...\n"));
      // Use tail -f equivalent
      const { spawn } = await import("node:child_process");
      const tail = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
      await new Promise((resolve) => tail.on("close", resolve));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(pc.yellow("No logs yet. Logs will appear after running `mcx serve`."));
      console.log(pc.dim(`Log file: ${LOG_FILE}`));
    } else {
      throw error;
    }
  }
}
