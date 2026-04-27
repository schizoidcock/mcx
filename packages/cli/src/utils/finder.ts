/**
 * File Finder Management
 * 
 * Linus principles:
 * - Single responsibility (FFF lifecycle)
 * - No special cases (unified lookup chain)
 * - Functions <20 lines
 */

import * as path from "node:path";
import pc from "picocolors";
import { getMcxHomeDir } from "../utils/paths.js";
import type { FileFinder } from "../utils/fff";

import { createDebugger } from "../utils/debug.js";

const debug = createDebugger("finder");

// ============================================================================
// Types
// ============================================================================

export interface FinderCache {
  basePath: string;
  mainFinder: FileFinder | null;
  watchedProjects: Map<string, FileFinder>;
  cachedFinders: Map<string, { finder: FileFinder; lastUsed: number }>;
  creating: Map<string, Promise<FileFinder | null>>;
  FileFinderClass: typeof import("@ff-labs/fff-bun").FileFinder | null;
}

export type McpResult = { 
  content: Array<{ type: "text"; text: string }>; 
  isError?: boolean 
};

// ============================================================================
// Constants
// ============================================================================

const CACHE_MAX = 5;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Factory
// ============================================================================

export async function createFinderCache(
  basePath: string, 
  disableFrecency?: boolean
): Promise<FinderCache> {
  const cache: FinderCache = {
    basePath,
    mainFinder: null,
    watchedProjects: new Map(),
    cachedFinders: new Map(),
    creating: new Map(),
    FileFinderClass: null,
  };

  try {
    const { FileFinder: FF } = await import("@ff-labs/fff-bun");
    cache.FileFinderClass = FF;
    
    const result = FF.create({
      basePath,
      frecencyDbPath: disableFrecency ? "" : path.join(getMcxHomeDir(), "frecency.db"),
    });
    
    if (result.ok) {
      cache.mainFinder = result.value;
      console.error(pc.dim(`FFF initialized for: ${basePath}`));
      cache.mainFinder.waitForScan(5000);
    } else {
      console.error(pc.yellow(`FFF init skipped: ${result.error}`));
    }
  } catch (e) {
    console.error(pc.yellow(`FFF not available - mcx_find/mcx_grep disabled`));
    console.error(pc.red(`FFF error: ${e}`));
  }

  return cache;
}

// ============================================================================
// Cache Management
// ============================================================================

function cleanExpiredFinders(cache: FinderCache): void {
  const now = Date.now();
  for (const [p, entry] of cache.cachedFinders.entries()) {
    if (now - entry.lastUsed > CACHE_TTL) {
      entry.finder.destroy();
      cache.cachedFinders.delete(p);
    }
  }
}

async function getCachedFinder(
  cache: FinderCache, 
  searchPath: string
): Promise<FileFinder | null> {
  cleanExpiredFinders(cache);

  // Check cache first
  const cached = cache.cachedFinders.get(searchPath);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.finder;
  }

  // Check if already creating
  const creating = cache.creating.get(searchPath);
  if (creating) return creating;

  if (!cache.FileFinderClass) return null;

  // Create new finder
  const createPromise = (async () => {
    const result = cache.FileFinderClass!.create({
      basePath: searchPath,
      frecencyDbPath: "",
    });
    if (!result.ok) return null;

    // Evict oldest if at capacity
    if (cache.cachedFinders.size >= CACHE_MAX) {
      const oldest = [...cache.cachedFinders.entries()]
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (oldest) {
        oldest[1].finder.destroy();
        cache.cachedFinders.delete(oldest[0]);
      }
    }

    cache.cachedFinders.set(searchPath, { finder: result.value, lastUsed: Date.now() });
    return result.value;
  })();

  cache.creating.set(searchPath, createPromise);
  try {
    return await createPromise;
  } finally {
    cache.creating.delete(searchPath);
  }
}

// ============================================================================
// Unified Finder Access (Linus: no special cases)
// ============================================================================

/**
 * Get finder for path using unified lookup chain:
 * 1. watchedProjects (explicit watch)
 * 2. cachedFinders (LRU cache)
 * 3. mainFinder (default)
 */
export async function withFinder<T>(
  cache: FinderCache,
  searchPath: string | undefined,
  fn: (finder: FileFinder) => T | Promise<T>
): Promise<T | McpResult> {
  const normalizedSearch = searchPath ? path.resolve(searchPath) : null;
  const normalizedBase = path.resolve(cache.basePath);
  const isExternal = normalizedSearch && normalizedSearch !== normalizedBase;

  // Unified lookup chain (Linus: no if/else for cases)
  const finder = isExternal
    ? cache.watchedProjects.get(normalizedSearch!) 
      || await getCachedFinder(cache, normalizedSearch!)
    : cache.mainFinder;

  if (!finder) {
    const msg = isExternal 
      ? `Failed to initialize search in: ${searchPath}`
      : "FFF not initialized. Run from a project directory.";
    return { content: [{ type: "text" as const, text: msg }],  };
  }

  return fn(finder);
}

// ============================================================================
// Cleanup
// ============================================================================

export function destroyFinderCache(cache: FinderCache): void {
  cache.mainFinder?.destroy();
  for (const [, entry] of cache.cachedFinders) {
    entry.finder.destroy();
  }
  for (const [, finder] of cache.watchedProjects) {
    finder.destroy();
  }
}