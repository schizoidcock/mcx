/**
 * mcx_watch Tool
 * 
 * Manage which project directories are watched for automatic FTS5 content indexing.
 */

import { basename, resolve, join } from "node:path";
import type { FileFinder } from "@ff-labs/fff-bun";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatError } from "./utils.js";
import { startDaemon, stopDaemon } from "../daemon/index.js";

// ============================================================================
// Types
// ============================================================================

export interface WatchParams {
  projects?: string[];
  action?: "add" | "remove" | "list";
}

// ============================================================================
// Utilities
// ============================================================================

function getMcxHomeDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".mcx");
}

// Lazy-loaded FileFinder class
let FileFinderClass: typeof import("@ff-labs/fff-bun").FileFinder | null = null;

async function getFileFinderClass() {
  if (!FileFinderClass) {
    const mod = await import("@ff-labs/fff-bun");
    FileFinderClass = mod.FileFinder;
  }
  return FileFinderClass;
}

// ============================================================================
// Handler
// ============================================================================

async function handleWatch(
  ctx: ToolContext,
  params: WatchParams
): Promise<McpResult> {
  const { projects = [], action = "add" } = params;
  const { watchedProjects } = ctx;

  // List action
  if (action === "list" || (projects.length === 0 && action !== "remove")) {
    const watched = Array.from(watchedProjects.keys());
    if (watched.length === 0) {
      return "No projects currently watched.";
    }
    return `Watched projects (${watched.length}):\n` + 
      watched.map(p => `  - ${p}`).join("\n");
  }

  // Remove action
  if (action === "remove") {
    const removed: string[] = [];
    for (const projectPath of projects) {
      const normalized = resolve(projectPath);
      const finder = watchedProjects.get(normalized);
      if (finder) {
        finder.destroy();
        watchedProjects.delete(normalized);
        removed.push(normalized);
      }
    }
    
    // Restart daemon with remaining projects
    if (watchedProjects.size > 0) {
      startDaemon(watchedProjects);
    } else {
      stopDaemon();
    }
    
    if (removed.length === 0) {
      return "No matching projects to remove.";
    }
    return `Stopped watching: ${removed.join(", ")}`;
  }

  // Add action
  const FF = await getFileFinderClass();
  const added: string[] = [];
  const errors: string[] = [];

  for (const projectPath of projects) {
    const normalized = resolve(projectPath);
    
    // Skip if already watching
    if (watchedProjects.has(normalized)) {
      continue;
    }

    // Create new FileFinder for this project
    const projectHash = basename(normalized).replace(/[^a-zA-Z0-9]/g, "_");
    const init = FF.create({
      basePath: normalized,
      frecencyDbPath: join(getMcxHomeDir(), `frecency-${projectHash}.db`),
    });

    if (init.ok) {
      init.value.waitForScan(5000);
      watchedProjects.set(normalized, init.value);
      added.push(normalized);
    } else {
      errors.push(`${normalized}: ${init.error}`);
    }
  }

  // Start/restart daemon with all watched projects
  if (watchedProjects.size > 0) {
    startDaemon(watchedProjects);
  }

  const result: string[] = [];
  if (added.length > 0) {
    result.push(`Now watching: ${added.join(", ")}`);
  }
  if (errors.length > 0) {
    result.push(`Errors: ${errors.join("; ")}`);
  }
  result.push(`Total projects watched: ${watchedProjects.size}`);

  return result.join("\n");
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxWatch: ToolDefinition<WatchParams> = {
  name: "mcx_watch",
  description: `Manage which project directories are watched for automatic FTS5 content indexing.

Examples:
- mcx_watch({ projects: ["/path/to/project"] }) - Add project to watch
- mcx_watch({ projects: [], action: "list" }) - List watched projects
- mcx_watch({ projects: ["/path"], action: "remove" }) - Stop watching

The daemon automatically indexes file changes in watched projects.`,
  inputSchema: {
    type: "object",
    properties: {
      projects: {
        type: "array",
        items: { type: "string" },
        description: "List of project paths to watch/unwatch",
      },
      action: {
        type: "string",
        description: "Action to perform",
        enum: ["add", "remove", "list"],
        default: "add",
      },
    },
  },
  handler: handleWatch,
};

export default mcxWatch;
