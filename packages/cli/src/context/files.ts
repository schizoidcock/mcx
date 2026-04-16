/**
 * File State Tracking
 */

// ============================================================================
// Types
// ============================================================================

interface FileState {
  storedAt?: number;    // When file was stored with storeAs
  editedAt?: number;    // When file was last edited
  accessCount: number;  // How many times accessed
}

// ============================================================================
// State
// ============================================================================

const state = new Map<string, FileState>();

// ============================================================================
// Update Functions
// ============================================================================

/**
 * Update file state - one function handles all actions
 */
export function updateFile(path: string, action: 'store' | 'edit' | 'access'): void {
  const s = state.get(path) || { accessCount: 0 };
  
  if (action === 'store') s.storedAt = Date.now();
  if (action === 'edit') s.editedAt = Date.now();
  s.accessCount++;
  
  state.set(path, s);
}

/**
 * Record file store timestamp.
 */
export function recordStore(path: string): void {
  updateFile(path, 'store');
}

/**
 * Record file edit (alias for clarity)
 */
export function recordEdit(path: string): void {
  updateFile(path, 'edit');
}

/**
 * Record file access (alias for clarity)
 */
export function recordAccess(path: string): void {
  updateFile(path, 'access');
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Check if file is stale (edited after stored)
 */
export function isStale(path: string): boolean {
  const s = state.get(path);
  if (!s?.storedAt || !s?.editedAt) return false;
  return s.editedAt > s.storedAt;
}

/**
 * Get time since file was stored
 */
export function getStoredAt(path: string): number | undefined {
  return state.get(path)?.storedAt;
}

/**
 * Get time since file was edited
 */
export function getEditedAt(path: string): number | undefined {
  return state.get(path)?.editedAt;
}

/**
 * Get access count for file
 */
export function getAccessCount(path: string): number {
  return state.get(path)?.accessCount || 0;
}

/**
 * Check if file has been stored
 */
export function hasStored(path: string): boolean {
  return state.get(path)?.storedAt !== undefined;
}

/**
 * Clear file tracking for a path (metadata only).
 */
export function clearFileTracking(path: string): void {
  state.delete(path);
}

// ============================================================================
// Maintenance
// ============================================================================

/**
 * Cleanup entries older than maxAge
 */
export function cleanup(maxAgeMs = 30 * 60 * 1000): number {
  const now = Date.now();
  let removed = 0;
  
  for (const [path, s] of state) {
    const lastTouch = Math.max(s.storedAt || 0, s.editedAt || 0);
    if (now - lastTouch > maxAgeMs) {
      if (s.varName) pathByVar.delete(s.varName);
      state.delete(path);
      removed++;
    }
  }
  
  return removed;
}

/**
 * Clear all file metadata.
 */
export function clear(): void {
  state.clear();
}

/**
 * Get state size (for stats)
 */
export function size(): number {
  return state.size;
}
