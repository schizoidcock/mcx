export interface ExecutionResult {
  success: boolean;
  value?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
  duration?: number;
}

export interface SandboxState {
  variables: Record<string, unknown>;
  executionCount: number;
  lastExecution?: Date;
}

export interface ExecuteOptions {
  timeout?: number;
  memoryLimit?: number;
  /** Intent for auto-indexing large outputs */
  intent?: string;
  /** Max output size before truncation */
  maxOutput?: number;
}

export interface TruncateOptions {
  /** Max total characters */
  maxLength?: number;
  /** Head ratio (default 0.6 = 60%) */
  headRatio?: number;
}
