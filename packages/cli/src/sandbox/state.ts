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

  constructor() {
    this.state = {
      variables: {},
      executionCount: 0,
      lastExecution: undefined,
    };
    this.meta = new Map();
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
   */
  compressStale(maxAgeMs = 5 * 60 * 1000, minSize = 1000): string[] {
    const now = Date.now();
    const compressed: string[] = [];

    for (const [name, meta] of this.meta.entries()) {
      if (meta.compressed) continue;
      if (meta.originalSize < minSize) continue;
      if (now - meta.accessedAt < maxAgeMs) continue;

      if (this.compress(name)) {
        compressed.push(name);
      }
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
