/**
 * Shared FFF (Fast File Finder) utilities
 */
import { normalizePath } from "./paths.js";

// Type inferred from FFF module - shared between serve.ts and gen.ts
export type FileFinder = Awaited<ReturnType<typeof import("@ff-labs/fff-bun")>>["FileFinder"] extends
  { create: (opts: unknown) => { ok: true; value: infer T } } ? T : never;

/** Paths to exclude from file operations */
export const EXCLUDED_PATH_SEGMENTS = ["node_modules", "dist", ".git", ".next", "build", "out"] as const;

/** Check if a path should be excluded from results */
export function isExcludedPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const segments = normalized.split("/");
  return segments.some(seg => EXCLUDED_PATH_SEGMENTS.includes(seg as typeof EXCLUDED_PATH_SEGMENTS[number]));
}
