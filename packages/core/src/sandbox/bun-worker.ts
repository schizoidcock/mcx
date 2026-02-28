import type { ExecutionContext, SandboxConfig, SandboxResult } from "../types.js";
import type { ISandbox } from "./interface.js";
import { DEFAULT_NETWORK_POLICY, generateNetworkIsolationCode } from "./network-policy.js";
import { normalizeCode } from "./normalizer.js";
import { analyze, formatFindings, DEFAULT_ANALYSIS_CONFIG } from "./analyzer/index.js";

const DEFAULT_CONFIG: Required<SandboxConfig> = {
  timeout: 5000,
  memoryLimit: 128, // Not enforced in workers, kept for API compat
  allowAsync: true,
  globals: {},
  networkPolicy: DEFAULT_NETWORK_POLICY,
  normalizeCode: true,
  analysis: DEFAULT_ANALYSIS_CONFIG,
};

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

  constructor(config?: SandboxConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
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
      for (const [name, methods] of Object.entries(context.adapters)) {
        adapterMethods[name] = Object.keys(methods);
      }

      // Worker code - runs in isolated context
      // The Function constructor here is INTENTIONAL - this is a code execution sandbox
      const workerCode = this.buildWorkerCode();

      const blob = new Blob([workerCode], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      const worker = new Worker(url);

      let resolved = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          if (timeoutId) clearTimeout(timeoutId);
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      };

      // Timeout handler
      timeoutId = setTimeout(() => {
        if (!resolved) {
          cleanup();
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
          resolve({
            success: data.success,
            value: data.value as T,
            error: data.error,
            logs: [...logs, ...(data.logs || [])],
            executionTime: performance.now() - startTime,
          });
        }
      };

      worker.onerror = (error: ErrorEvent) => {
        cleanup();
        resolve({
          success: false,
          error: { name: "WorkerError", message: error.message || "Unknown worker error" },
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

      self.onmessage = async (event) => {
        const { type, data } = event.data;

        if (type === 'init') {
          const { variables, adapterMethods, globals } = data;

          for (const [key, value] of Object.entries(variables || {})) {
            globalThis[key] = value;
          }

          for (const [key, value] of Object.entries(globals || {})) {
            globalThis[key] = value;
          }

          globalThis.adapters = {};
          for (const [adapterName, methods] of Object.entries(adapterMethods)) {
            const adapterObj = {};
            for (const methodName of methods) {
              adapterObj[methodName] = async (...args) => {
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
            globalThis.adapters[adapterName] = adapterObj;
            globalThis[adapterName] = adapterObj;
          }

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
            self.postMessage({ type: 'result', success: true, value: result, logs });
          } catch (err) {
            // Truncate stack to 5 lines to prevent context bloat
            const stack = err.stack ? err.stack.split('\\n').slice(0, 5).join('\\n') : undefined;
            self.postMessage({
              type: 'result',
              success: false,
              error: { name: err.name, message: err.message, stack },
              logs
            });
          }
        }
      };
    `;
  }

  dispose(): void {
    // Workers are created per execution, nothing to dispose
  }
}

export function createSandbox(config?: SandboxConfig): ISandbox {
  return new BunWorkerSandbox(config);
}
