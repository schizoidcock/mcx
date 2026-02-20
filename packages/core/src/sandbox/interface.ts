import type { ExecutionContext, SandboxConfig, SandboxResult } from "../types.js";

/**
 * Interface for sandbox implementations
 *
 * Sandboxes provide isolated code execution environments
 * with configurable resource limits and adapter injection.
 */
export interface ISandbox {
  /**
   * Execute code in the sandbox
   *
   * @param code - JavaScript code to execute
   * @param context - Execution context with adapters and variables
   * @returns Result containing the value, logs, and execution metadata
   */
  execute<T = unknown>(code: string, context: ExecutionContext): Promise<SandboxResult<T>>;

  /**
   * Get the current sandbox configuration
   */
  getConfig(): SandboxConfig;

  /**
   * Update sandbox configuration
   *
   * @param config - New configuration options to merge
   */
  configure(config: Partial<SandboxConfig>): void;

  /**
   * Dispose of sandbox resources
   */
  dispose(): void;
}

/**
 * Factory function type for creating sandbox instances
 */
export type SandboxFactory = (config?: SandboxConfig) => ISandbox;
