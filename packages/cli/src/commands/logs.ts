/**
 * MCX Logs Command
 * View and manage MCX session logs
 * 
 * Structure: ~/.mcx/logs/{YYYY-MM-DD}/{category}.toon
 */

import { readdir, readFile, rm, } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { LOG_DIR } from "../utils/logger";
import { decode } from "@toon-format/toon";

export interface LogsOptions {
  lines?: number;
  clear?: boolean;
  date?: string;      // YYYY-MM-DD, default today
  category?: string;  // session, execute, file, search, fetch, adapter, tasks, stats
  all?: boolean;      // show all categories
}


/**
 * Get available dates (folders)
 */
async function getDates(): Promise<string[]> {
  try {
    const entries = await readdir(LOG_DIR);
    return entries
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Get available categories for a date
 */
async function getCategories(date: string): Promise<string[]> {
  try {
    const dir = join(LOG_DIR, date);
    const files = await readdir(dir);
    return files
      .filter(f => f.endsWith(".toon"))
      .map(f => f.replace(".toon", ""));
  } catch {
    return [];
  }
}

/**
 * Read and parse TOON log file
 */
async function readLogFile(date: string, category: string, maxLines: number): Promise<unknown[]> {
  try {
    const file = join(LOG_DIR, date, `${category}.toon`);
    const content = await readFile(file, "utf-8");
    const lines = content.trim().split("\n").slice(-maxLines);
    
    return lines.map(line => {
      try {
        return decode(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Format a log event for display
 */
function formatEvent(event: Record<string, unknown>, category: string): string {
  const ts = pc.dim(String(event.ts || ""));
  
  if (category === "session") {
    if (event.type === "start") {
      return `${ts} ${pc.green("▶")} MCX v${event.v} (${event.transport}) pid=${event.pid}`;
    }
    if (event.type === "stop") {
      return `${ts} ${pc.yellow("■")} Stopped: ${event.reason}`;
    }
    if (event.type === "crash") {
      return `${ts} ${pc.red("✗")} CRASH: ${event.err}`;
    }
    if (event.level === "ERROR") {
      return `${ts} ${pc.red("ERROR")} ${event.msg}`;
    }
    if (event.level === "WARN") {
      return `${ts} ${pc.yellow("WARN")} ${event.msg}`;
    }
    return `${ts} ${event.msg || JSON.stringify(event)}`;
  }
  
  // Tool events
  const ok = event.ok ? pc.green("✓") : pc.red("✗");
  const tool = String(event.tool || category);
  const ms = pc.dim(`${event.ms}ms`);
  const ch = pc.dim(`${event.ch}ch`);
  
  let line = `${ts} ${ok} ${tool} ${ms} ${ch}`;
  if (event.err) {
    line += `\n     ${pc.red(String(event.err))}`;
  }
  return line;
}

export async function logsCommand(options: LogsOptions = {}): Promise<void> {
  const maxLines = options.lines ?? 50;

  // Clear all logs
  if (options.clear) {
    const dates = await getDates();
    for (const date of dates) {
      try {
        await rm(join(LOG_DIR, date), { recursive: true });
      } catch { /* ignore */ }
    }
    console.log(pc.green(`Cleared ${dates.length} days of logs`));
    return;
  }

  // Get date to show
  const dates = await getDates();
  if (dates.length === 0) {
    console.log(pc.yellow("No logs found"));
    return;
  }

  const date = options.date || dates[0];
  if (!dates.includes(date)) {
    console.log(pc.yellow(`No logs for ${date}. Available: ${dates.slice(0, 5).join(", ")}`));
    return;
  }

  const categories = await getCategories(date);
  if (categories.length === 0) {
    console.log(pc.yellow(`No logs for ${date}`));
    return;
  }

  // Determine which categories to show
  let showCategories: string[];
  if (options.all) {
    showCategories = categories;
  } else if (options.category) {
    if (!categories.includes(options.category)) {
      console.log(pc.yellow(`Category "${options.category}" not found. Available: ${categories.join(", ")}`));
      return;
    }
    showCategories = [options.category];
  } else {
    // Default: show session + most recent tool category
    showCategories = ["session"];
    const toolCats = categories.filter(c => c !== "session");
    if (toolCats.length > 0) showCategories.push(toolCats[0]);
  }

  // Header
  console.log(pc.dim(`=== ${date} ===\n`));

  // Show each category
  for (const category of showCategories) {
    const events = await readLogFile(date, category, maxLines);
    
    if (events.length === 0) continue;
    
    console.log(pc.cyan(`[${category}]`));
    for (const event of events) {
      console.log(formatEvent(event as Record<string, unknown>, category));
    }
    console.log();
  }

  // Footer
  console.log(pc.dim(`Categories: ${categories.join(", ")} | Days: ${dates.length}`));
}
