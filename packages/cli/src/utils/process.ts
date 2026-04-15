/**
 * Safe Process Execution
 */

import { HARD_CAP_BYTES, DEFAULT_TIMEOUT } from "../tools/constants.js";

// ============================================================================
// Types
// ============================================================================

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface SpawnOptions {
  timeout?: number;
  maxBytes?: number;
  cwd?: string;
  env?: Record<string, string>;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Safe spawn - ONE function handles everything
 * - Timeout with process tree cleanup
 * - Output limit to prevent OOM
 * - Works on Windows and Unix
 */
export async function safeSpawn(cmd: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxBytes = opts.maxBytes ?? HARD_CAP_BYTES;
  
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  
  // Setup timeout
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid);
  }, timeout);
  
  // Collect output with limit
  const [stdout, truncOut] = await collectWithLimit(proc.stdout, maxBytes / 2);
  const [stderr, truncErr] = await collectWithLimit(proc.stderr, maxBytes / 2);
  
  // Wait for exit
  const exitCode = timedOut ? null : await proc.exited;
  clearTimeout(timer);
  
  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    truncated: truncOut || truncErr,
  };
}

// ============================================================================
// Shell Convenience
// ============================================================================

const SHELL_PATH = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\sh.exe'
  : '/bin/sh';

/**
 * Run shell command with safety
 */
export async function safeShell(cmd: string, opts: SpawnOptions = {}): Promise<SpawnResult> {
  return safeSpawn([SHELL_PATH, '-c', cmd], opts);
}

/**
 * Run Python with safety
 */
export async function safePython(code: string, opts: SpawnOptions = {}): Promise<SpawnResult> {
  return safeSpawn(['python3', '-c', code], opts);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Kill process tree - Windows and Unix in one function
 */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      // Windows: taskkill with /T kills child processes
      Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)]);
    } else {
      // Unix: negative PID kills process group
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Process already dead - ignore
  }
}

/**
 * Collect stream output with byte limit
 */
async function collectWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<[string, boolean]> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  
  const reader = stream.getReader();
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      if (total + value.length > maxBytes) {
        // Take partial chunk up to limit
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
        }
        truncated = true;
        break;
      }
      
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  
  // Concatenate and decode
  const combined = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  
  return [new TextDecoder().decode(combined), truncated];
}

// ============================================================================
// Exported for Testing
// ============================================================================

export { killTree };
