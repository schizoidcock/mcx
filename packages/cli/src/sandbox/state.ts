import type { SandboxState } from './types.js';

/**
 * Persistent sandbox state that survives across executions.
 * Variables stored here are available in subsequent mcx_execute calls.
 */
export class PersistentState {
  private state: SandboxState;

  constructor() {
    this.state = {
      variables: {},
      executionCount: 0,
      lastExecution: undefined,
    };
  }

  /**
   * Get a stored variable.
   */
  get(name: string): unknown {
    return this.state.variables[name];
  }

  /**
   * Set a variable (persists across executions).
   */
  set(name: string, value: unknown): void {
    this.state.variables[name] = value;
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
