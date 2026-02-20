/**
 * MCX Path Utilities
 * Shared helpers for resolving MCX directories
 */
import { dirname, join } from "node:path";

/**
 * Get the MCX CLI directory (packages/cli)
 */
export function getMcxCliDir(): string {
  const currentDir = import.meta.dir;
  let dir = currentDir;

  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, "package.json");
    const file = Bun.file(pkgPath);
    try {
      const exists = file.size > 0;
      if (exists) {
        return dir;
      }
    } catch {}
    dir = dirname(dir);
  }

  return currentDir;
}

/**
 * Get the MCX root directory (where adapters/ and mcx.config.ts live)
 * Walks up from cwd looking for mcx.config.ts, falls back to cwd
 */
export function getMcxRootDir(): string {
  let dir = process.cwd();

  while (dir !== dirname(dir)) {
    const configPath = join(dir, "mcx.config.ts");
    const configFile = Bun.file(configPath);
    try {
      if (configFile.size > 0) {
        return dir;
      }
    } catch {}
    dir = dirname(dir);
  }

  // Fall back to cwd if no config found
  return process.cwd();
}

/**
 * Get the default adapters directory (in user's project)
 */
export function getAdaptersDir(): string {
  return join(getMcxRootDir(), "adapters");
}

/**
 * Get the config file path
 */
export function getConfigPath(): string {
  return join(getMcxRootDir(), "mcx.config.ts");
}
