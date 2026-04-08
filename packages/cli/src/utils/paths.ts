/**
 * MCX Path Utilities
 * Shared helpers for resolving MCX directories
 */
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { access } from "node:fs/promises";

/** Max directory depth to traverse (prevents symlink loops) */
const MAX_TRAVERSE_DEPTH = 100;

/**
 * Get the global MCX home directory (~/.mcx)
 */
export function getMcxHomeDir(): string {
  return join(homedir(), ".mcx");
}

/**
 * Ensure the global MCX home directory structure exists
 * Creates ~/.mcx/, ~/.mcx/adapters/, ~/.mcx/skills/ if not present
 */
export function ensureMcxHomeDir(): string {
  const homeDir = getMcxHomeDir();
  const adaptersDir = join(homeDir, "adapters");
  const skillsDir = join(homeDir, "skills");

  // mkdirSync with recursive is idempotent - no need to check existence first
  // This also avoids TOCTOU race conditions
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(adaptersDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  return homeDir;
}

/**
 * Get the MCX CLI directory (packages/cli)
 */
export function getMcxCliDir(): string {
  const currentDir = import.meta.dir;
  let dir = currentDir;
  let depth = 0;

  while (dir !== dirname(dir) && depth < MAX_TRAVERSE_DEPTH) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      return dir;
    }
    dir = dirname(dir);
    depth++;
  }

  return currentDir;
}

/**
 * Get the MCX root directory (where adapters/ and mcx.config.ts live)
 * Returns ~/.mcx/ by default (global mode)
 * Use findProjectRoot() if you need to find a local project config
 */
export function getMcxRootDir(): string {
  return getMcxHomeDir();
}

/**
 * Find a project-local MCX config by walking up from a directory
 * Returns null if no mcx.config.ts found
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  // Resolve to absolute path to normalize input
  let dir = resolve(startDir);
  let depth = 0;

  while (dir !== dirname(dir) && depth < MAX_TRAVERSE_DEPTH) {
    const configPath = join(dir, "mcx.config.ts");
    if (existsSync(configPath)) {
      return dir;
    }
    dir = dirname(dir);
    depth++;
  }

  return null;
}

/**
 * Get the default adapters directory (~/.mcx/adapters)
 */
export function getAdaptersDir(): string {
  return join(getMcxHomeDir(), "adapters");
}

/**
 * Get the config file path (~/.mcx/mcx.config.ts)
 */
export function getConfigPath(): string {
  return join(getMcxHomeDir(), "mcx.config.ts");
}

/**
 * Get the global .env file path (~/.mcx/.env)
 */
export function getEnvPath(): string {
  return join(getMcxHomeDir(), ".env");
}

/**
 * Check if a file or directory exists (async).
 * Prefer this over sync existsSync for non-blocking checks.
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compact a path by replacing middle segments with "..."
 * e.g., "packages/cli/src/commands/serve.ts" → "packages/.../serve.ts"
 */
export function compactPath(filePath: string, maxLen = 50): string {
  if (filePath.length <= maxLen) return filePath;
  
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) {
    return '...' + filePath.slice(-(maxLen - 3));
  }
  
  const first = parts[0];
  const last = parts[parts.length - 1];
  const minimal = `${first}/.../${last}`;
  
  if (minimal.length <= maxLen) {
    let result = last;
    for (let i = parts.length - 2; i > 0; i--) {
      const candidate = `${first}/.../` + parts.slice(i).join('/');
      if (candidate.length <= maxLen) {
        result = parts.slice(i).join('/');
      } else break;
    }
    return `${first}/.../` + result;
  }
  
  return '.../' + last.slice(-(maxLen - 4));
}
