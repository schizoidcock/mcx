/**
 * MCX Path Utilities
 * Shared helpers for resolving MCX directories
 */
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

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

  if (!existsSync(homeDir)) {
    mkdirSync(homeDir, { recursive: true });
  }
  if (!existsSync(adaptersDir)) {
    mkdirSync(adaptersDir, { recursive: true });
  }
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  return homeDir;
}

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
  let dir = startDir;

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
