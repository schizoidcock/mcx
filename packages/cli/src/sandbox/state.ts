import type { SandboxState } from './types.js';

/** Variable metadata for compression tracking */
interface VariableMeta {
  setAt: number;
  accessedAt: number;
  originalSize: number;
  compressed: boolean;
}

/**
 * Persistent sandbox state that survives across executions.
 * Variables stored here are available in subsequent mcx_execute calls.
 */
export class PersistentState {
  private state: SandboxState;
  private meta: Map<string, VariableMeta>;
  
  // Optimization #13: Track which files are stored in which variables
  private storedFileVars: Map<string, string>; // path → varName
  private fileStoreTime: Map<string, number>;  // path → store timestamp
  private editTime: Map<string, number>;       // path → edit timestamp

  constructor() {
    this.state = {
      variables: {},
      executionCount: 0,
      lastExecution: undefined,
    };
    this.meta = new Map();
    this.storedFileVars = new Map();
    this.fileStoreTime = new Map();
    this.editTime = new Map();
  }

  /**
   * Get a stored variable.
   */
  get(name: string): unknown {
    const meta = this.meta.get(name);
    if (meta) {
      meta.accessedAt = Date.now();
    }
    return this.state.variables[name];
  }

  /**
   * Set a variable (persists across executions).
   */
  set(name: string, value: unknown): void {
    this.state.variables[name] = value;
    const size = JSON.stringify(value)?.length || 0;
    this.meta.set(name, {
      setAt: Date.now(),
      accessedAt: Date.now(),
      originalSize: size,
      compressed: false,
    });
  }

  /**
   * Check if a variable exists.
   */
  has(name: string): boolean {
    return name in this.state.variables;
  }

  /**
   * Delete a variable.
   */
  delete(name: string): boolean {
    if (name in this.state.variables) {
      delete this.state.variables[name];
      this.meta.delete(name);
      // Clean storedFileVars entry for this variable
      for (const [path, varName] of this.storedFileVars) {
        if (varName === name) {
          this.storedFileVars.delete(path);
          this.fileStoreTime.delete(path);
          break;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Get all variable names.
   */
  keys(): string[] {
    return Object.keys(this.state.variables);
  }

  /**
   * Get all variables as a plain object.
   * Used to inject into sandbox context.
   */
  getAll(): Record<string, unknown> {
    return { ...this.state.variables };
  }

  /**
   * Get all variables with $ prefix for sandbox injection.
   * Converts { foo: 1 } to { $foo: 1 }.
   */
  getAllPrefixed(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.state.variables)) {
      result[`$${key}`] = value;
    }
    return result;
  }

  /**
   * Merge multiple variables at once.
   */
  merge(vars: Record<string, unknown>): void {
    Object.assign(this.state.variables, vars);
  }

  /**
   * Clear all variables.
   */
  clear(): void {
    this.state.variables = {};
    this.meta.clear();
    this.storedFileVars.clear();
    this.fileStoreTime.clear();
    this.editTime.clear();
  }

  /**
   * Compress a variable to save memory/context.
   * Replaces arrays with summary, keeps first few items.
   */
  compress(name: string, keepItems = 3): boolean {
    const value = this.state.variables[name];
    if (!value || !Array.isArray(value)) return false;

    const meta = this.meta.get(name);
    if (meta?.compressed) return false;

    const summary = {
      __compressed__: true,
      type: 'array',
      totalItems: value.length,
      sample: value.slice(0, keepItems),
      keys: value.length > 0 && typeof value[0] === 'object'
        ? Object.keys(value[0] || {})
        : undefined,
    };

    this.state.variables[name] = summary;
    if (meta) {
      meta.compressed = true;
    }
    return true;
  }

  /**
   * Compress old variables that haven't been accessed recently.
   * @param maxAgeMs - Max age in ms since last access (default: 5 minutes)
   * @param minSize - Minimum size in chars to compress (default: 1000)
   * @param isIndexed - Optional function to check if var is indexed (safe to compress immediately)
   */
  compressStale(
    maxAgeMs = 5 * 60 * 1000,
    minSize = 1000,
    isIndexed?: (varName: string) => boolean
  ): string[] {
    const now = Date.now();
    const compressed: string[] = [];

    for (const [name, meta] of this.meta.entries()) {
      if (meta.compressed) continue;

      // If indexed in FTS5 → safe to compress (data accessible via search)
      if (isIndexed?.(name)) {
        if (this.compress(name)) compressed.push(name);
        continue;
      }

      // Not indexed → use age/size heuristics
      if (meta.originalSize < minSize) continue;
      if (now - meta.accessedAt < maxAgeMs) continue;
      if (this.compress(name)) compressed.push(name);
    }

    return compressed;
  }

  /**
   * Get variable metadata for diagnostics.
   */
  getMeta(name: string): VariableMeta | undefined {
    return this.meta.get(name);
  }

  /**
   * Record an execution.
   */
  recordExecution(): void {
    this.state.executionCount++;
    this.state.lastExecution = new Date();
  }

  /**
   * Get execution count.
   */
  getExecutionCount(): number {
    return this.state.executionCount;
  }

  /**
   * Get stats for mcx_stats tool.
   */
  getStats(): { variableCount: number; executionCount: number; lastExecution?: Date } {
    return {
      variableCount: Object.keys(this.state.variables).length,
      executionCount: this.state.executionCount,
      lastExecution: this.state.lastExecution,
    };
  }

  // === Optimization #13: storedFileVars methods ===

  /**
   * Register a file as stored in a variable.
   */
  setFileVar(path: string, varName: string): void {
    this.storedFileVars.set(path, varName);
    this.fileStoreTime.set(path, Date.now());
  }

  /**
   * Get the variable name for a stored file.
   */
  getFileVar(path: string): string | undefined {
    return this.storedFileVars.get(path);
  }

  /**
   * Get the store time for a file.
   */
  getFileStoreTime(path: string): number | undefined {
    return this.fileStoreTime.get(path);
  }

  /**
   * Set edit time for a file.
   */
  setEditTime(path: string): void {
    this.editTime.set(path, Date.now());
  }

  /**
   * Get edit time for a file.
   */
  getEditTime(path: string): number | undefined {
    return this.editTime.get(path);
  }

  /**
   * Cleanup stale time entries (TTL-based).
   */
  cleanupTimeMaps(maxAgeMs = 30 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    
    for (const [path, time] of this.fileStoreTime) {
      if (time < cutoff) { this.fileStoreTime.delete(path); removed++; }
    }
    for (const [path, time] of this.editTime) {
      if (time < cutoff) { this.editTime.delete(path); removed++; }
    }
    
    return removed;
  }

  /**
   * Clear a specific file's stored var tracking.
   */
  clearFileVar(path: string): void {
    this.storedFileVars.delete(path);
    this.fileStoreTime.delete(path);
    this.editTime.delete(path);
  }

  /**
   * Reverse lookup: find path for a variable name.
   */
  getPathForVar(varName: string): string | undefined {
    for (const [path, name] of this.storedFileVars) {
      if (name === varName) return path;
    }
    return undefined;
  }
}

// Singleton instance for the session
let instance: PersistentState | null = null;

export function getSandboxState(): PersistentState {
  if (!instance) {
    instance = new PersistentState();
  }
  return instance;
}

export function resetSandboxState(): void {
  instance = null;
}
