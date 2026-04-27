/**
 * Robust Debug System for MCX Development
 * 
 * Features:
 * - Structured logging with consistent fields
 * - Log levels: trace, debug, info, warn, error
 * - Context/span tracking for request tracing
 * - Output formats: pretty (terminal) or TOON (file)
 * - State inspection helpers
 * - Zero overhead when disabled
 * 
 * Usage:
 *   MCX_DEBUG=* mcx serve                    # All modules, all levels
 *   MCX_DEBUG=sandbox,file mcx serve         # Specific modules
 *   MCX_DEBUG=sandbox:pool mcx serve         # Sub-module
 *   MCX_DEBUG_LEVEL=trace mcx serve          # Set minimum level (default: debug)
 *   MCX_DEBUG_FORMAT=toon mcx serve          # TOON tabular output for piping
 *   MCX_DEBUG_FILE=/tmp/mcx.log mcx serve    # Write to file
 * 
 * In code:
 *   import { createDebugger } from './utils/debug.js';
 *   const debug = createDebugger('sandbox');
 *   
 *   debug.info('worker started', { pid: 123 });
 *   debug.time('compile');
 *   debug.timeEnd('compile');
 *   
 *   const span = debug.span('handleRequest');
 *   span.debug('processing', { step: 1 });
 *   span.end();
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// ============================================================================
// Types
// ============================================================================

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  spanId?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
  error?: { name: string; message: string; stack?: string };
}

interface Span {
  id: string;
  trace: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, err?: Error, data?: Record<string, unknown>) => void;
  end: (data?: Record<string, unknown>) => void;
}

interface Debugger {
  enabled: boolean;
  trace: (msg: string, data?: Record<string, unknown>) => void;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, err?: Error, data?: Record<string, unknown>) => void;
  error: (msg: string, err?: Error, data?: Record<string, unknown>) => void;
  time: (label: string) => void;
  timeEnd: (label: string, data?: Record<string, unknown>) => void;
  span: (name: string, data?: Record<string, unknown>) => Span;
  dump: (label: string, obj: unknown) => void;
}

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  pattern: RegExp | null;
  minLevel: number;
  format: 'pretty' | 'toon';
  file: string | null;
  initialized: boolean;
}

const LEVELS: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const LEVEL_NAMES: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

const config: Config = {
  pattern: null,
  minLevel: LEVELS.debug,
  format: 'toon',
  file: null,
  initialized: false,
};

// ============================================================================
// ANSI Colors
// ============================================================================

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

const MODULE_COLORS = [C.cyan, C.yellow, C.magenta, C.green, C.blue];
const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: C.gray,
  debug: C.dim,
  info: C.green,
  warn: C.yellow,
  error: C.red,
};

const moduleColorMap = new Map<string, string>();
let colorIdx = 0;

// ============================================================================
// State
// ============================================================================

const timers = new Map<string, number>();
let spanCounter = 0;
let headerWritten = false;

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
  if (config.initialized) return;
  config.initialized = true;
  
  const env = process.env.MCX_DEBUG || '';
  if (!env) return;
  
  // Pattern
  if (env === '*') {
    config.pattern = /.*/;
  } else {
    const parts = env.split(',').map(p => p.trim()).filter(Boolean);
    const regex = parts.map(p => {
      if (p.endsWith(':*')) return p.slice(0, -2) + '(:|$).*';
      if (p.endsWith('*')) return p.slice(0, -1) + '.*';
      return p + '(:|$)?';
    }).join('|');
    config.pattern = new RegExp(`^(${regex})`);
  }
  
  // Level
  const levelEnv = process.env.MCX_DEBUG_LEVEL?.toLowerCase() as LogLevel;
  if (levelEnv && levelEnv in LEVELS) {
    config.minLevel = LEVELS[levelEnv];
  }
  
  // Format
  if (process.env.MCX_DEBUG_FORMAT === 'toon') {
    config.format = 'toon';
  }
  
  // File - default to ~/.mcx/logs/YYYY-MM-DD/debug.log when debug is enabled
  const today = new Date().toISOString().slice(0, 10);
  const fileEnv = process.env.MCX_DEBUG_FILE || join(homedir(), '.mcx', 'logs', today, 'debug.toon');
  config.file = fileEnv;
  const dir = dirname(fileEnv);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function reloadDebugConfig(): void {
  config.initialized = false;
  init();
}

function isEnabled(module: string): boolean {
  init();
  return config.pattern?.test(module) ?? false;
}

function getModuleColor(module: string): string {
  if (!moduleColorMap.has(module)) {
    moduleColorMap.set(module, MODULE_COLORS[colorIdx++ % MODULE_COLORS.length]);
  }
  return moduleColorMap.get(module)!;
}

// ============================================================================
// Formatting
// ============================================================================

function timestamp(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function shortTime(): string {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function formatData(data: Record<string, unknown> | undefined): string {
  if (!data || Object.keys(data).length === 0) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (typeof v === 'string') parts.push(`${k}=${v}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    else parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return parts.length > 0 ? ` ${C.dim}${parts.join(' ')}${C.reset}` : '';
}

function formatPretty(entry: LogEntry): string {
  const moduleColor = getModuleColor(entry.module);
  const levelColor = LEVEL_COLORS[entry.level];
  const level = entry.level.toUpperCase().padEnd(5);
  const span = entry.spanId ? `${C.dim}[${entry.spanId}]${C.reset} ` : '';
  const duration = entry.durationMs !== undefined ? ` ${C.bold}${entry.durationMs.toFixed(1)}ms${C.reset}` : '';
  const data = formatData(entry.data);
  const error = entry.error ? `\n  ${C.red}${entry.error.name}: ${entry.error.message}${C.reset}` : '';
  
  return `${C.dim}${shortTime()}${C.reset} ${levelColor}${level}${C.reset} ${moduleColor}${entry.module}${C.reset} ${span}${entry.msg}${duration}${data}${error}`;
}

function formatTOON(entry: LogEntry): string {
  // TOON tabular: ts,level,module,span,msg,ms,data
  const data = entry.data ? Object.entries(entry.data).map(([k,v]) => k + '=' + (typeof v === 'string' ? v : JSON.stringify(v))).join(' ') : '';
  const err = entry.error ? ' ERR:' + entry.error.message : '';
  const dur = entry.durationMs !== undefined ? entry.durationMs.toFixed(1) + 'ms' : '';
  const span = entry.spanId || '';
  return [entry.ts, entry.level.toUpperCase(), entry.module, span, entry.msg, dur, data + err].filter(Boolean).join(',');
}

// ============================================================================
// Output
// ============================================================================

function output(entry: LogEntry): void {
  if (LEVELS[entry.level] < config.minLevel) return;
  
  const formatted = config.format === 'toon' ? formatTOON(entry) : formatPretty(entry);
  
  if (config.file) {
    if (!headerWritten) {
      const header = 'debug{ts,level,module,span,msg,ms,data}:\n';
      appendFileSync(config.file, header);
      headerWritten = true;
    }
    appendFileSync(config.file, formatted + '\n');
  } else {
    console.error(formatted);
  }
}

// ============================================================================
// Debugger Factory (Linus: helpers eliminate duplication)
// ============================================================================

type Data = Record<string, unknown>;
type LogFn = (level: LogLevel, msg: string, data?: Data, error?: Error, spanId?: string, durationMs?: number) => void;

// Linus: data structure > code duplication
function createLogMethods(log: LogFn, spanId?: string) {
  const methods: Record<string, Function> = {};
  for (const level of LEVEL_NAMES) {
    methods[level] = level === 'warn' || level === 'error'
      ? (msg: string, err?: Error, data?: Data) => log(level, msg, data, err instanceof Error ? err : undefined, spanId)
      : (msg: string, data?: Data) => log(level, msg, data, undefined, spanId);
  }
  return methods as Pick<Debugger, 'trace' | 'debug' | 'info' | 'warn' | 'error'>;
}

function createLogFn(module: string): LogFn {
  return (level, msg, data, error, spanId, durationMs) => {
    if (!isEnabled(module)) return;
    output({
      ts: timestamp(), level, module, msg, spanId, durationMs, data,
      error: error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
    });
  };
}

function createTimerMethods(module: string, log: LogFn) {
  return {
    time: (label: string) => {
      if (!isEnabled(module)) return;
      timers.set(`${module}:${label}`, performance.now());
    },
    timeEnd: (label: string, data?: Record<string, unknown>) => {
      if (!isEnabled(module)) return;
      const key = `${module}:${label}`;
      const start = timers.get(key);
      if (start === undefined) return;
      timers.delete(key);
      log('debug', label, data, undefined, undefined, performance.now() - start);
    },
  };
}

function createSpan(module: string, log: LogFn) {
  return (name: string, initialData?: Record<string, unknown>): Span => {
    const id = `${module.split(':')[0]}-${++spanCounter}`;
    const start = performance.now();
    if (isEnabled(module)) log('debug', `→ ${name}`, initialData, undefined, id);
    return {
      id,
      ...createLogMethods(log, id),
      end: (data) => {
        if (isEnabled(module)) log('debug', `← ${name}`, data, undefined, id, performance.now() - start);
      },
    };
  };
}

export function createDebugger(module: string): Debugger {
  const log = createLogFn(module);
  
  return {
    get enabled() { return isEnabled(module); },
    ...createLogMethods(log),
    ...createTimerMethods(module, log),
    span: createSpan(module, log),
    dump: (label, obj) => {
      if (!isEnabled(module)) return;
      const s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
      log('debug', `DUMP ${label}`, { value: s.slice(0, 500) + (s.length > 500 ? '...' : '') });
    },
  };
}

// ============================================================================
// Pre-configured debuggers
// ============================================================================

export const debugSandbox = createDebugger('sandbox');
export const debugFile = createDebugger('file');
export const debugGrep = createDebugger('grep');
export const debugFind = createDebugger('find');
export const debugExecute = createDebugger('execute');
export const debugServer = createDebugger('server');
export const debugStore = createDebugger('store');
export const debugAdapter = createDebugger('adapter');
export const debugHelpers = createDebugger('helpers');
export const debugRegister = createDebugger('register');

// ============================================================================
// Legacy compatibility (dbg function)
// ============================================================================

export const dbg = createDebugger;
