/**
 * Debug System for MCX Core
 * 
 * Usage: MCX_DEBUG=sandbox mcx serve
 */

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';

const timers = new Map<string, number>();
const moduleColors = new Map<string, string>();
let colorIndex = 0;
let pattern: RegExp | null = null;
let init = false;

function initialize(): void {
  if (init) return;
  init = true;
  const env = process.env.MCX_DEBUG || '';
  if (!env) return;
  if (env === '*') { pattern = /.*/; return; }
  const parts = env.split(',').map(p => p.trim()).filter(Boolean);
  pattern = new RegExp(`^(${parts.map(p => p.replace('*', '.*')).join('|')})`);
}

function isEnabled(ns: string): boolean {
  initialize();
  return pattern?.test(ns) ?? false;
}

function getColor(ns: string): string {
  if (!moduleColors.has(ns)) {
    moduleColors.set(ns, COLORS[colorIndex++ % COLORS.length]);
  }
  return moduleColors.get(ns)!;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function fmt(val: unknown): string {
  if (val === null || val === undefined) return String(val);
  if (typeof val === 'string') return val;
  if (val instanceof Error) return `${val.name}: ${val.message}`;
  try { return JSON.stringify(val); } catch { return String(val); }
}

export interface DebugFn {
  (...args: unknown[]): void;
  enabled: boolean;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  error: (...args: unknown[]) => void;
}

export function dbg(ns: string): DebugFn {
  const enabled = isEnabled(ns);
  const color = getColor(ns);
  
  const debug = ((...args: unknown[]) => {
    if (!enabled) return;
    console.error(`${DIM}${ts()}${RESET} ${color}${ns}${RESET}`, args.map(fmt).join(' '));
  }) as DebugFn;
  
  debug.enabled = enabled;
  debug.time = (label: string) => { if (enabled) timers.set(`${ns}:${label}`, performance.now()); };
  debug.timeEnd = (label: string) => {
    if (!enabled) return;
    const key = `${ns}:${label}`;
    const start = timers.get(key);
    if (start === undefined) return;
    timers.delete(key);
    console.error(`${DIM}${ts()}${RESET} ${color}${ns}${RESET} ${label} ${BOLD}${(performance.now() - start).toFixed(1)}ms${RESET}`);
  };
  debug.error = (...args: unknown[]) => {
    if (!enabled) return;
    console.error(`${DIM}${ts()}${RESET} ${color}${ns}${RESET} ${RED}ERROR${RESET}`, args.map(fmt).join(' '));
  };
  
  return debug;
}

export const debugSandbox = dbg('sandbox');
export const debugPool = dbg('sandbox:pool');
export const debugWorker = dbg('sandbox:worker');
