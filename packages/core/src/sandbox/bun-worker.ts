import type { ExecutionContext, SandboxConfig, SandboxResult } from "../types.js";
import type { ISandbox } from "./interface.js";
import { DEFAULT_NETWORK_POLICY, generateNetworkIsolationCode } from "./network-policy.js";
import { normalizeCode } from "./normalizer.js";
import { analyze, formatFindings, DEFAULT_ANALYSIS_CONFIG } from "./analyzer/index.js";

/** Get current memory usage in MB */
function getMemoryUsageMB(): { heapUsed: number; heapTotal: number; rss: number } {
  const mem = process.memoryUsage();
  return {
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    rss: Math.round(mem.rss / 1024 / 1024),
  };
}

/** Memory warning threshold in MB */
const MEMORY_WARNING_THRESHOLD = 256;

const DEFAULT_POOL_CONFIG = {
  enabled: true,
  maxWorkers: 4,
  idleTimeout: 30000,
};

const DEFAULT_CONFIG: Required<SandboxConfig> = {
  timeout: 5000,
  memoryLimit: 128, // Not enforced in workers, kept for API compat
  allowAsync: true,
  globals: {},
  networkPolicy: DEFAULT_NETWORK_POLICY,
  normalizeCode: true,
  analysis: DEFAULT_ANALYSIS_CONFIG,
  pool: DEFAULT_POOL_CONFIG,
};

/** Pooled worker wrapper */
interface PooledWorker {
  worker: Worker;
  url: string;
  busy: boolean;
  lastUsed: number;
  executionCount: number;
}

/** Worker pool for reusing workers across executions */
class WorkerPool {
  private workers: PooledWorker[] = [];
  private maxWorkers: number;
  private idleTimeout: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(maxWorkers = 4, idleTimeout = 30000) {
    this.maxWorkers = maxWorkers;
    this.idleTimeout = idleTimeout;
    this.startCleanup();
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      this.workers = this.workers.filter(pw => {
        const isIdle = !pw.busy && (now - pw.lastUsed) > this.idleTimeout;
        if (isIdle) {
          pw.worker.terminate();
          URL.revokeObjectURL(pw.url);
        }
        return !isIdle;
      });
    }, 10000);
  }

  acquire(workerCode: string): PooledWorker | null {
    // Reuse available worker
    const available = this.workers.find(pw => !pw.busy);
    if (available) {
      available.busy = true;
      available.executionCount++;
      return available;
    }
    // Create new if pool not full
    if (this.workers.length < this.maxWorkers) {
      const blob = new Blob([workerCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        const worker = new Worker(url, { smol: true });
        const pw: PooledWorker = { worker, url, busy: true, lastUsed: Date.now(), executionCount: 1 };
        this.workers.push(pw);
        return pw;
      } catch {
        URL.revokeObjectURL(url);
        return null;
      }
    }
    return null; // Pool exhausted
  }

  release(pw: PooledWorker): void {
    pw.busy = false;
    pw.lastUsed = Date.now();
  }

  remove(pw: PooledWorker): void {
    const idx = this.workers.indexOf(pw);
    if (idx >= 0) this.workers.splice(idx, 1);
    try { pw.worker.terminate(); URL.revokeObjectURL(pw.url); } catch { /* cleanup error */ }
  }

  dispose(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.cleanupInterval = null;
    for (const pw of this.workers) {
      try { pw.worker.terminate(); URL.revokeObjectURL(pw.url); } catch { /* dispose error */ }
    }
    this.workers = [];
  }

  get stats() {
    return { total: this.workers.length, busy: this.workers.filter(w => w.busy).length };
  }
}

/**
 * Bun Worker based sandbox implementation.
 * Uses native Bun Workers for isolated code execution.
 *
 * ## Security Layers
 *
 * 1. **Worker Isolation** - Code runs in separate JavaScript context
 *    with no access to main thread's scope
 *
 * 2. **Network Isolation** - fetch/WebSocket blocked by default
 *    (configurable via networkPolicy)
 *
 * 3. **Pre-execution Analysis** - Detects infinite loops, dangerous
 *    patterns, adapter calls in loops before execution
 *
 * 4. **Code Normalization** - AST-based validation and auto-return
 *
 * 5. **Timeout** - Configurable execution timeout (default 5s)
 *
 * SECURITY NOTE: This sandbox intentionally uses dynamic code execution
 * (Function constructor) within an isolated Worker context. The Worker
 * provides the security boundary.
 */
export class BunWorkerSandbox implements ISandbox {
  private config: Required<SandboxConfig>;
  private pool: WorkerPool | null = null;

  constructor(config?: SandboxConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const poolConfig = this.config.pool ?? DEFAULT_POOL_CONFIG;
    if (poolConfig.enabled) {
      this.pool = new WorkerPool(poolConfig.maxWorkers, poolConfig.idleTimeout);
    }
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }

  configure(config: Partial<SandboxConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async execute<T = unknown>(
    code: string,
    context: ExecutionContext
  ): Promise<SandboxResult<T>> {
    const startTime = performance.now();

    // Normalize code if enabled (auto-add return, etc.)
    let normalizedCode = code;
    if (this.config.normalizeCode) {
      const result = normalizeCode(code);
      if (result.error) {
        // Return parse error immediately
        return {
          success: false,
          error: { name: "SyntaxError", message: result.error },
          logs: [],
          executionTime: performance.now() - startTime,
        };
      }
      normalizedCode = result.code;
    }

    // Pre-execution analysis
    const analysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, ...this.config.analysis };
    const analysisResult = analyze(normalizedCode, analysisConfig);
    const logs: string[] = [];

    // Add warnings to logs
    if (analysisResult.warnings.length > 0) {
      logs.push(...formatFindings(analysisResult.warnings));
    }

    // Block execution if there are errors and blockOnError is enabled
    if (analysisResult.errors.length > 0 && analysisConfig.blockOnError) {
      const errorMessages = formatFindings(analysisResult.errors);
      logs.push(...errorMessages);
      return {
        success: false,
        error: {
          name: "AnalysisError",
          message: `Code analysis found ${analysisResult.errors.length} error(s): ${analysisResult.errors[0].message}`,
        },
        logs,
        executionTime: performance.now() - startTime,
      };
    }

    // If there are errors but blockOnError is false, add them as warnings
    if (analysisResult.errors.length > 0) {
      logs.push(...formatFindings(analysisResult.errors));
    }

    return new Promise((resolve) => {
      // Build adapter method names for the worker
      const adapterMethods: Record<string, string[]> = {};
      for (const [name, methods] of Object.entries(context.adapters || {})) {
        adapterMethods[name] = Object.keys(methods as object);
      }

      // Worker code - runs in isolated context
      // The Function constructor here is INTENTIONAL - this is a code execution sandbox
      const workerCode = this.buildWorkerCode();

      // Use pool if available, otherwise create worker directly
      let pooledWorker: PooledWorker | null = null;
      let worker: Worker;
      let url: string;
      
      if (this.pool) {
        // First attempt to acquire from pool
        // Try to acquire from pool
        pooledWorker = this.pool.acquire(workerCode);
        // No retry - if pool is exhausted, return error immediately
        if (pooledWorker === null) {
          return resolve({
            success: false,
            error: { name: "PoolExhaustedError", message: "Worker pool exhausted, try again later" },
            logs: [...logs, `[ERROR] Pool exhausted (max: ${this.config.pool?.maxWorkers ?? 4})`],
            executionTime: performance.now() - startTime, // pool exhausted
          });
        }
        worker = pooledWorker.worker;
        url = pooledWorker.url;
      } else {
        // Direct worker creation (pool disabled)
        const blob = new Blob([workerCode], { type: "application/javascript" });
        url = URL.createObjectURL(blob);
        try {
          worker = new Worker(url, { smol: true });
        } catch (err) {
          URL.revokeObjectURL(url);
          const errorMsg = err instanceof Error ? err.message : String(err);
          return resolve({
            success: false,
            error: { name: "WorkerCreationError", message: `Failed to create worker: ${errorMsg}` },
            logs: [...logs, `[ERROR] Worker creation failed: ${errorMsg}`],
            executionTime: performance.now() - startTime, // creation error
          });
        }
      }
      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (error = false) => {
        if (!resolved) {
          resolved = true;
          if (timeoutId) clearTimeout(timeoutId);
          if (pooledWorker && this.pool) {
            // Return to pool or remove on error
            if (error) {
              this.pool.remove(pooledWorker);
            } else {
              this.pool.release(pooledWorker);
            }
          } else {
            // Direct worker - terminate and cleanup
            worker.terminate();
            URL.revokeObjectURL(url);
          }
        }
      };

      // Timeout handler
      timeoutId = setTimeout(() => {
        if (!resolved) {
          cleanup(true); // timeout error
          resolve({
            success: false,
            error: { name: "TimeoutError", message: `Execution timed out after ${this.config.timeout}ms` },
            logs,
            executionTime: performance.now() - startTime,
          });
        }
      }, this.config.timeout);

      worker.onmessage = async (event: MessageEvent) => {
        // Guard against stale messages after resolution
        if (resolved) return;

        const { type, ...data } = event.data;

        if (type === "ready") {
          worker.postMessage({ type: "execute", data: { code: normalizedCode } });
        }

        else if (type === "adapter_call") {
          const { adapter, method, args, id } = data;
          try {
            const adapterObj = context.adapters[adapter];
            if (!adapterObj || !adapterObj[method]) {
              throw new Error(`Adapter method not found: ${adapter}.${method}`);
            }
            const result = await (adapterObj[method] as Function)(...args);
            worker.postMessage({ type: "adapter_result", data: { id, result } });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            worker.postMessage({ type: "adapter_result", data: { id, error } });
          }
        }

        else if (type === "result") {
          cleanup();
          // Add memory warning to logs if usage is high
          const mem = getMemoryUsageMB();
          const resultLogs = [...logs, ...(data.logs || [])];
          if (mem.heapUsed > MEMORY_WARNING_THRESHOLD) {
            resultLogs.push(`[WARN] High memory: heap=${mem.heapUsed}MB, rss=${mem.rss}MB`);
          }
          resolve({
            success: data.success,
            value: data.value as T,
            error: data.error,
            logs: resultLogs,
            executionTime: performance.now() - startTime,
            tracking: data.tracking,
          });
        }
      };

      worker.onerror = (error: ErrorEvent) => {
        cleanup(true); // worker error - remove from pool
        // Include memory stats in error for debugging
        const mem = getMemoryUsageMB();
        const memInfo = `[Memory: heap=${mem.heapUsed}/${mem.heapTotal}MB, rss=${mem.rss}MB]`;
        const isMemoryIssue = mem.heapUsed > MEMORY_WARNING_THRESHOLD;
        const errorMsg = error.message || "Unknown worker error";
        logs.push(`[WORKER_ERROR] ${errorMsg} ${memInfo}`);
        if (isMemoryIssue) {
          logs.push(`[WARN] High memory usage detected - consider using smaller data chunks`);
        }
        resolve({
          success: false,
          error: { 
            name: isMemoryIssue ? "MemoryError" : "WorkerError", 
            message: `${errorMsg} ${memInfo}` 
          },
          logs,
          executionTime: performance.now() - startTime,
        });
      };

      worker.postMessage({
        type: "init",
        data: {
          variables: context.variables || {},
          adapterMethods,
          globals: this.config.globals,
        },
      });
    });
  }

  private buildWorkerCode(): string {
    // Generate network isolation code based on policy
    const networkIsolation = generateNetworkIsolationCode(this.config.networkPolicy);

    // This code runs inside the isolated Worker
    return `
      // Network isolation (injected based on policy)
      ${networkIsolation}

      // FS/Net tracking - counts bytes and operations
      let __mcx_fs_bytes = 0;
      let __mcx_fs_count = 0;
      let __mcx_net_bytes = 0;
      let __mcx_net_count = 0;

      // Wrap Bun.file to track filesystem reads
      const _real_bun_file = Bun.file.bind(Bun);
      Bun.file = function(path) {
        const file = _real_bun_file(path);
        // Return a proxy that tracks reads while delegating everything else to original
        return new Proxy(file, {
          get(target, prop) {
            if (prop === 'text') return async () => { const r = await target.text(); __mcx_fs_bytes += r.length; __mcx_fs_count++; return r; };
            if (prop === 'arrayBuffer') return async () => { const r = await target.arrayBuffer(); __mcx_fs_bytes += r.byteLength; __mcx_fs_count++; return r; };
            if (prop === 'json') return async () => { const r = await target.json(); __mcx_fs_bytes += JSON.stringify(r).length; __mcx_fs_count++; return r; };
            if (prop === 'bytes') return async () => { const r = await target.bytes(); __mcx_fs_bytes += r.length; __mcx_fs_count++; return r; };
            const val = target[prop];
            return typeof val === 'function' ? val.bind(target) : val;
          }
        });
      };

      const logs = [];
      const pendingCalls = new Map();
      let callId = 0;

      // Safe stringify that handles BigInt and circular refs
      const safeStr = (val) => {
        if (typeof val !== 'object' || val === null) return String(val);
        try {
          const seen = new WeakSet();
          return JSON.stringify(val, (k, v) => {
            if (typeof v === 'bigint') return v.toString() + 'n';
            if (typeof v === 'object' && v !== null) {
              if (seen.has(v)) return '[Circular]';
              seen.add(v);
            }
            return v;
          });
        } catch { return String(val); }
      };

      const console = {
        log: (...args) => logs.push(args.map(safeStr).join(' ')),
        warn: (...args) => logs.push('[WARN] ' + args.map(safeStr).join(' ')),
        error: (...args) => logs.push('[ERROR] ' + args.map(safeStr).join(' ')),
        info: (...args) => logs.push('[INFO] ' + args.map(safeStr).join(' ')),
      };
      globalThis.console = console;

      globalThis.pick = (arr, fields) => {
        if (!Array.isArray(arr)) return arr;
        return arr.map(item => {
          const result = {};
          for (const field of fields) {
            const parts = field.split('.');
            let value = item;
            let key = parts[parts.length - 1];
            for (const part of parts) value = value?.[part];
            result[key] = value;
          }
          return result;
        });
      };

      globalThis.table = (arr, maxRows = 10) => {
        if (!Array.isArray(arr) || arr.length === 0) return '(empty)';
        const items = arr.slice(0, maxRows);
        const keys = Object.keys(items[0]);
        const header = '| ' + keys.join(' | ') + ' |';
        const sep = '|' + keys.map(() => '---').join('|') + '|';
        const rows = items.map(item => '| ' + keys.map(k => String(item[k] ?? '')).join(' | ') + ' |');
        let result = [header, sep, ...rows].join('\\n');
        if (arr.length > maxRows) result += '\\n... +' + (arr.length - maxRows) + ' more rows';
        return result;
      };

      globalThis.count = (arr, field) => {
        if (!Array.isArray(arr)) return {};
        return arr.reduce((acc, item) => {
          const key = String(item[field] ?? 'unknown');
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {});
      };

      globalThis.sum = (arr, field) => {
        if (!Array.isArray(arr)) return 0;
        return arr.reduce((acc, item) => acc + (Number(item[field]) || 0), 0);
      };

      globalThis.first = (arr, n = 5) => {
        if (!Array.isArray(arr)) return arr;
        return arr.slice(0, n);
      };

      /**
       * Poll a function until condition is met or max iterations reached.
       * @param fn - Async function to call. Return { done: true, value } to stop.
       * @param opts - { interval: ms (default 1000), maxIterations: n (default 10) }
       * @returns Array of all results, or last result if done:true was returned
       */
      globalThis.poll = async (fn, opts = {}) => {
        const interval = opts.interval ?? 1000;
        const maxIterations = opts.maxIterations ?? 10;
        const results = [];

        for (let i = 0; i < maxIterations; i++) {
          const result = await fn(i);
          results.push(result);

          // Check for done signal
          if (result && typeof result === 'object' && result.done) {
            return result.value !== undefined ? result.value : results;
          }

          // Wait before next iteration (skip on last)
          if (i < maxIterations - 1) {
            await new Promise(r => setTimeout(r, interval));
          }
        }

        return results;
      };

      /**
       * Wait for a condition to become true.
       * @param fn - Async function that returns truthy when done
       * @param opts - { interval: ms (default 500), timeout: ms (default 10000) }
       * @returns The truthy value returned by fn
       */
      globalThis.waitFor = async (fn, opts = {}) => {
        const interval = opts.interval ?? 500;
        const timeout = opts.timeout ?? 10000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
          const result = await fn();
          if (result) return result;
          await new Promise(r => setTimeout(r, interval));
        }

        throw new Error('waitFor timeout after ' + timeout + 'ms');
      };

      // File helpers (lines, grep, around, block, outline) are NOT provided here.
      // Use mcx_execute which prepends FILE_HELPERS_CODE with proper error messages.

      // Track user-set variables for cleanup between executions (pooled workers)
      const userVariableKeys = new Set<string>();

      // SECURITY: Reserved keys that must not be overwritten by user-provided variables/globals
      const RESERVED_KEYS = new Set([
        'onmessage', 'postMessage', 'close', 'terminate', 'self',
        'constructor', 'prototype', '__proto__',
        'pendingCalls', 'callId', 'logs', 'console', 'adapters',
        'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
        'pick', 'table', 'count', 'sum', 'first', 'safeStr', 'poll', 'waitFor'
      ]);

      self.onmessage = async (event) => {
        const { type, data } = event.data;

        if (type === 'init') {
          const { variables, adapterMethods, globals } = data;

          // SECURITY: Clean up variables from previous execution (pooled worker reuse)
          for (const key of userVariableKeys) {
            try { delete globalThis[key]; } catch { /* ignore */ }
          }
          userVariableKeys.clear();

          // Inject user variables (skip reserved keys to prevent internal state corruption)
          for (const [key, value] of Object.entries(variables || {})) {
            if (RESERVED_KEYS.has(key)) {
              logs.push('[WARN] Skipped reserved variable key: ' + key);
              continue;
            }
            userVariableKeys.add(key); // Track for cleanup on next init
            globalThis[key] = value;
          }

          // Inject sandbox globals (skip reserved keys)
          for (const [key, value] of Object.entries(globals || {})) {
            if (RESERVED_KEYS.has(key)) {
              logs.push('[WARN] Skipped reserved globals key: ' + key);
              continue;
            }
            userVariableKeys.add(key); // Track globals too for cleanup
            globalThis[key] = value;
          }

          // Levenshtein distance for fuzzy matching
          const levenshtein = (a, b) => {
            if (a.length === 0) return b.length;
            if (b.length === 0) return a.length;
            const matrix = [];
            for (let i = 0; i <= b.length; i++) matrix[i] = [i];
            for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
            for (let i = 1; i <= b.length; i++) {
              for (let j = 1; j <= a.length; j++) {
                matrix[i][j] = b[i-1] === a[j-1]
                  ? matrix[i-1][j-1]
                  : Math.min(matrix[i-1][j-1] + 1, matrix[i][j-1] + 1, matrix[i-1][j] + 1);
              }
            }
            return matrix[b.length][a.length];
          };

          // Convert camelCase to snake_case
          const toSnakeCase = (str) => str
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
            .toLowerCase();

          // Find similar method names
          const findSimilar = (name, methods, maxDist = 3) => {
            const normalized = name.toLowerCase().replace(/[-_]/g, '');
            return methods
              .map(m => ({ method: m, dist: levenshtein(normalized, m.toLowerCase().replace(/[-_]/g, '')) }))
              .filter(x => x.dist <= maxDist)
              .sort((a, b) => a.dist - b.dist)
              .slice(0, 3)
              .map(x => x.method);
          };

          // Find best auto-correctable match (distance ≤ 2 = safe to auto-correct)
          const findAutoCorrect = (name, methods) => {
            // Try exact snake_case conversion first
            const snake = toSnakeCase(name);
            if (methods.includes(snake)) return snake;

            // Try normalized fuzzy match
            const normalized = name.toLowerCase().replace(/[-_]/g, '');
            const matches = methods
              .map(m => ({ method: m, dist: levenshtein(normalized, m.toLowerCase().replace(/[-_]/g, '')) }))
              .filter(x => x.dist <= 2) // Only auto-correct if very close
              .sort((a, b) => a.dist - b.dist);

            return matches.length > 0 ? matches[0].method : null;
          };

          // Create adapter proxies with helpful error messages
          const adaptersObj = {};
          for (const [adapterName, methods] of Object.entries(adapterMethods)) {
            const methodsImpl = {};
            for (const methodName of methods) {
              methodsImpl[methodName] = async (...args) => {
                const id = ++callId;
                return new Promise((resolve, reject) => {
                  pendingCalls.set(id, { resolve, reject });
                  self.postMessage({
                    type: 'adapter_call',
                    adapter: adapterName,
                    method: methodName,
                    args,
                    id
                  });
                });
              };
            }

            // Precompute auto-correct lookup (O(1) instead of O(n) per access)
            const autoCorrectMap = new Map();
            for (const m of methods) {
              // Map snake_case variants: execute_sql -> execute_sql (identity)
              autoCorrectMap.set(m, m);
              // Map normalized: executesql -> execute_sql
              autoCorrectMap.set(m.toLowerCase().replace(/[-_]/g, ''), m);
            }

            // Use Proxy to intercept undefined method calls with auto-correction
            const adapterProxy = new Proxy(methodsImpl, {
              get(target, prop) {
                if (prop in target) return target[prop];
                if (typeof prop === 'symbol') return undefined;

                const propStr = String(prop);

                // Fast path: check precomputed map (O(1))
                const snake = toSnakeCase(propStr);
                if (autoCorrectMap.has(snake)) {
                  return target[autoCorrectMap.get(snake)];
                }
                const normalized = propStr.toLowerCase().replace(/[-_]/g, '');
                if (autoCorrectMap.has(normalized)) {
                  return target[autoCorrectMap.get(normalized)];
                }

                // Slow path: fuzzy match for typos (only if fast path failed)
                const corrected = findAutoCorrect(propStr, methods);
                if (corrected && corrected in target) {
                  return target[corrected];
                }

                // No auto-correct possible, throw with suggestions
                const similar = findSimilar(propStr, methods);
                const suggestion = similar.length > 0
                  ? '. Did you mean: ' + similar.join(', ') + '?'
                  : '. Available: ' + methods.slice(0, 5).join(', ') + (methods.length > 5 ? '...' : '');
                throw new Error(adapterName + '.' + propStr + ' is not a function' + suggestion);
              }
            });

            adaptersObj[adapterName] = adapterProxy;
            // Also expose at top level (configurable for pooled worker reuse)
            Object.defineProperty(globalThis, adapterName, {
              value: adapterProxy,
              writable: false,
              configurable: true
            });
          }
          Object.defineProperty(globalThis, 'adapters', {
            value: adaptersObj,
            writable: false,
            configurable: true
          });

          self.postMessage({ type: 'ready' });
        }

        else if (type === 'adapter_result') {
          const { id, result, error } = data;
          const pending = pendingCalls.get(id);
          if (pending) {
            pendingCalls.delete(id);
            if (error) pending.reject(new Error(error));
            else pending.resolve(result);
          }
        }

        else if (type === 'execute') {
          try {
            // SECURITY: This runs in isolated Worker context
            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            const fn = new AsyncFunction(data.code);
            const result = await fn();

            // SECURITY: Hard cap on output size to prevent OOM
            const HARD_CAP_BYTES = 100 * 1024 * 1024; // 100MB
            const serialized = safeStr(result);
            if (serialized.length > HARD_CAP_BYTES) {
              self.postMessage({
                type: 'result',
                success: false,
                error: {
                  name: 'OutputSizeError',
                  message: 'Output exceeds 100MB limit. Use pagination or filtering.'
                },
                logs,
                tracking: { fsBytes: __mcx_fs_bytes, fsCount: __mcx_fs_count, netBytes: __mcx_net_bytes, netCount: __mcx_net_count }
              });
            } else {
              // Check memory and add warning if high
              const mem = process.memoryUsage();
              const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
              if (heapMB > 256) {
                logs.push('[WARN] High memory: heap=' + heapMB + 'MB - consider smaller data chunks');
              }
              self.postMessage({ type: 'result', success: true, value: result, logs, tracking: { fsBytes: __mcx_fs_bytes, fsCount: __mcx_fs_count, netBytes: __mcx_net_bytes, netCount: __mcx_net_count } });
            }
          } catch (err) {
            // Truncate stack to 5 lines to prevent context bloat
            const stack = err.stack ? err.stack.split('\\n').slice(0, 5).join('\\n') : undefined;
            self.postMessage({
              type: 'result',
              success: false,
              error: { name: err.name, message: err.message, stack },
              logs,
              tracking: { fsBytes: __mcx_fs_bytes, fsCount: __mcx_fs_count, netBytes: __mcx_net_bytes, netCount: __mcx_net_count }
            });
          }
        }
      };
    `;
  }

  getPoolStats(): { enabled: boolean; total: number; busy: number } | null {
    if (!this.pool) return null;
    return { enabled: true, ...this.pool.stats };
  }

  dispose(): void {
    if (this.pool) {
      this.pool.dispose();
      this.pool = null;
    }
  }
}

export function createSandbox(config?: SandboxConfig): ISandbox {
  return new BunWorkerSandbox(config);
}
