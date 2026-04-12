/**
 * Content Store Wrapper
 * 
 * Singleton wrapper around ContentStore for FTS5 indexing.
 * Provides lazy initialization and cleanup.
 */

import { ContentStore } from "../search/store.js";

let contentStore: ContentStore | null = null;

/**
 * Get or create the content store singleton.
 * Lazy initialization - only creates on first access.
 */
export function getContentStore(): ContentStore {
  if (!contentStore) {
    contentStore = new ContentStore();
  }
  return contentStore;
}

/**
 * Clear the content store (for testing or reset).
 */
export function clearContentStore(): void {
  if (contentStore) {
    contentStore.clear();
  }
}

/**
 * Cleanup stale content older than maxAge.
 * Called on startup to prevent unbounded growth.
 */
export function cleanupStaleContent(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const store = getContentStore();
  return store.cleanupStale(maxAgeMs);
}
