import type { ExecutionResult, ExecuteOptions } from './types.js';
import { getSandboxState } from './state.js';
import { smartTruncate } from './truncate.js';

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_OUTPUT = 25000;

/**
 * Execute code in sandbox with persistent state.
 *
 * The code has access to:
 * - $state: PersistentState for storing variables across executions
 * - $adapters: Adapter context for API calls
 * - All previously stored variables as globals
 */
export async function executeCode(
  code: string,
  context: Record<string, unknown>,
  options: ExecuteOptions = {}
): Promise<ExecutionResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const state = getSandboxState();

  const startTime = Date.now();

  try {
    // Build execution context with state variables
    const execContext = {
      ...context,
      ...state.getAll(),
      $state: {
        get: (name: string) => state.get(name),
        set: (name: string, value: unknown) => state.set(name, value),
        has: (name: string) => state.has(name),
        delete: (name: string) => state.delete(name),
        keys: () => state.keys(),
      },
    };

    // Create async function from code
    const fn = createSandboxedFunction(code, Object.keys(execContext));

    // Execute with timeout
    const result = await Promise.race([
      fn(...Object.values(execContext)),
      timeoutPromise(timeout),
    ]);

    state.recordExecution();

    // Serialize and truncate result
    const serialized = serializeResult(result);
    const truncated = smartTruncate(serialized, { maxLength: maxOutput });

    return {
      success: true,
      value: result,
      stdout: truncated,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    state.recordExecution();

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Creates a sandboxed async function from code string.
 *
 * NOTE: This intentionally uses dynamic code evaluation (Function constructor)
 * because MCX is a code execution tool - its purpose is to run user-provided code.
 * The sandbox context controls what the code can access.
 */
function createSandboxedFunction(
  code: string,
  contextKeys: string[]
): (...args: unknown[]) => Promise<unknown> {
  // Wrap code in async IIFE if not already a function
  const wrappedCode = code.trim().startsWith('(')
    ? `return (${code})()`
    : code.includes('return ')
    ? code
    : `return (${code})`;

  // Create function with context parameters
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    ...contextKeys,
    `"use strict"; return (async () => { ${wrappedCode} })()`
  );

  return fn as (...args: unknown[]) => Promise<unknown>;
}

/**
 * Timeout promise that rejects after specified ms.
 */
function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Execution timeout after ${ms}ms`)), ms);
  });
}

/**
 * Serialize result to string for output.
 */
function serializeResult(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Store execution result in state with a name.
 * Used by storeAs parameter in mcx_execute.
 */
export function storeResult(name: string, value: unknown): void {
  const state = getSandboxState();
  state.set(name, value);
}
