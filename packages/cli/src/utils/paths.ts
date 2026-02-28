/**
 * MCX Path Utilities
 * Shared helpers for resolving MCX directories
 */
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

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
