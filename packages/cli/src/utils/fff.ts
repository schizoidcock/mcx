/**
 * Shared FFF (Fast File Finder) utilities
 */

// Type inferred from FFF module - shared between serve.ts and gen.ts
export type FileFinder = Awaited<ReturnType<typeof import("@ff-labs/fff-bun")>>["FileFinder"] extends
  { create: (opts: unknown) => { ok: true; value: infer T } } ? T : never;

/** Paths to exclude from file operations */
export const EXCLUDED_PATH_SEGMENTS = ["node_modules", "dist", ".git", ".next", "build", "out"] as const;

/** Check if a path should be excluded from results */
export function isExcludedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return EXCLUDED_PATH_SEGMENTS.some(seg =>
    normalized.includes(`/${seg}/`) || normalized.includes(`/${seg}`)
  );
}
