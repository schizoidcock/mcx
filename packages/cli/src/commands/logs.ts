/**
 * MCX Logs Command
 * View and manage MCX log files
 */

import { open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { LOG_DIR, LOG_FILE, LOG_LEVELS } from "../utils/logger";

export interface LogsOptions {
  lines?: number;
  follow?: boolean;
  clear?: boolean;
}

/**
 * Read last N lines efficiently by reading from the end of the file
 */
async function readLastLines(filePath: string, numLines: number): Promise<{ lines: string[]; totalLines: number }> {
  const stats = await stat(filePath);
  const fileSize = stats.size;

  // For small files, just read the whole thing
  if (fileSize < 65536) {
    const file = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(fileSize);
      await file.read(buffer, 0, fileSize, 0);
      const content = buffer.toString("utf-8").trim();
      const allLines = content.split("\n");
      return {
        lines: allLines.slice(-numLines),
        totalLines: allLines.length,
      };
    } finally {
      await file.close();
    }
  }

  // For large files, read chunks from the end
  const chunkSize = Math.min(65536, fileSize); // 64KB chunks
  const file = await open(filePath, "r");
  try {
    const collectedLines: string[] = [];
    let position = fileSize;
    let partialLine = "";

    while (collectedLines.length < numLines && position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;

      const buffer = Buffer.alloc(readSize);
      await file.read(buffer, 0, readSize, position);
      const chunk = buffer.toString("utf-8");

      // Prepend partial line from previous chunk
      const lines = (chunk + partialLine).split("\n");
      partialLine = lines.shift() || ""; // First line may be partial

      // Push lines (we'll reverse at the end) - O(1) per line vs O(n) for spread
      for (const line of lines) {
        if (line) collectedLines.push(line);
      }
    }

    // Don't forget the final partial line
    if (partialLine) {
      collectedLines.push(partialLine);
    }

    // Reverse to get chronological order, then take last N
    collectedLines.reverse();
    return {
      lines: collectedLines.slice(-numLines),
      totalLines: collectedLines.length,
    };
  } finally {
    await file.close();
  }
}

function printColoredLine(line: string): void {
  if (line.includes(`[${LOG_LEVELS.ERROR}]`)) {
    console.log(pc.red(line));
  } else if (line.includes(`[${LOG_LEVELS.WARN}]`)) {
    console.log(pc.yellow(line));
  } else if (line.includes(`[${LOG_LEVELS.INFO}]`)) {
    console.log(pc.cyan(line));
  } else if (line.includes(`[${LOG_LEVELS.DEBUG}]`)) {
    console.log(pc.dim(line));
  } else {
    // Stack trace or continuation lines
    console.log(pc.dim(line));
  }
}

export async function logsCommand(options: LogsOptions = {}): Promise<void> {
  const lines = options.lines ?? 50;

  if (options.clear) {
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
    const { lines: lastLines, totalLines } = await readLastLines(LOG_FILE, lines);

    console.log(pc.dim(`=== ${LOG_FILE} (last ${lines} lines) ===\n`));

    for (const line of lastLines) {
      printColoredLine(line);
    }

    if (totalLines > lines) {
      console.log(pc.dim(`\n... ${totalLines - lines} earlier lines not shown`));
    }

    // Show log file stats
    const stats = await stat(LOG_FILE);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(pc.dim(`\nLog size: ${sizeKB} KB`));

    if (options.follow) {
      console.log(pc.dim("\nFollowing logs (Ctrl+C to stop)...\n"));
      await followLogs(LOG_FILE);
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

/**
 * Cross-platform log following using file watching
 */
async function followLogs(filePath: string): Promise<void> {
  const { watch } = await import("node:fs");
  let lastSize = (await stat(filePath)).size;

  const watcher = watch(filePath, async (eventType) => {
    if (eventType === "change") {
      try {
        const stats = await stat(filePath);
        if (stats.size > lastSize) {
          // Read new content
          const file = await open(filePath, "r");
          try {
            const newBytes = stats.size - lastSize;
            const buffer = Buffer.alloc(newBytes);
            await file.read(buffer, 0, newBytes, lastSize);
            const newContent = buffer.toString("utf-8");
            for (const line of newContent.split("\n").filter(Boolean)) {
              printColoredLine(line);
            }
          } finally {
            await file.close();
          }
          lastSize = stats.size;
        } else if (stats.size < lastSize) {
          // File was rotated/truncated
          console.log(pc.dim("--- log rotated ---"));
          lastSize = stats.size;
        }
      } catch {
        // File might have been deleted during rotation
      }
    }
  });

  // Wait forever (until Ctrl+C)
  await new Promise<void>(() => {
    process.on("SIGINT", () => {
      watcher.close();
      process.exit(0);
    });
  });
}
