#!/usr/bin/env bun
/**
 * Analyze Claude Code session history for token usage and MCX patterns.
 *
 * Usage:
 *   bun scripts/analyze-sessions.ts [days] [path]
 *   bun scripts/analyze-sessions.ts 7                           # Last 7 days, all projects
 *   bun scripts/analyze-sessions.ts 3 ~/.claude/projects/myproj # Specific project
 *   bun scripts/analyze-sessions.ts --session b53b3960          # Single session by ID
 *   bun scripts/analyze-sessions.ts --session b53b3960 --compare 45ece562  # Compare two
 *
 * Features:
 *   - Real token counts from usage field
 *   - Model-specific pricing (opus/sonnet/haiku)
 *   - Cache efficiency + cliff detection
 *   - Redundant file reads + edit retry detection
 *   - Single session deep-dive mode
 *   - Side-by-side session comparison
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// Parse args
const args = process.argv.slice(2);
const sessionIdx = args.indexOf('--session');
const compareIdx = args.indexOf('--compare');
const SESSION_ID = sessionIdx !== -1 ? args[sessionIdx + 1] : null;
const COMPARE_ID = compareIdx !== -1 ? args[compareIdx + 1] : null;
const DAYS = parseInt(args.find(a => /^\d+$/.test(a)) || '7');
const CUSTOM_PATH = args.find(a => a.startsWith('/') || a.startsWith('~') || a.includes(':\\'));
const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Model pricing ($ per million tokens)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'haiku': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
};

const BASH_TO_MCX: Record<string, string> = {
  'cat': 'mcx_file', 'head': 'mcx_file', 'tail': 'mcx_file',
  'grep': 'mcx_grep', 'rg': 'mcx_grep',
  'find': 'mcx_find', 'ls': 'mcx_tree',
  'curl': 'mcx_fetch', 'wget': 'mcx_fetch',
  'sed': 'mcx_edit', 'awk': 'mcx_file',
};

const NATIVE_TO_MCX: Record<string, string> = {
  'Read': 'mcx_file', 'Grep': 'mcx_grep', 'Edit': 'mcx_edit',
  'Write': 'mcx_write', 'Glob': 'mcx_find', 'WebFetch': 'mcx_fetch',
};

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string;
}

interface ToolCall {
  tool: string;
  timestamp: string;
  filePath?: string;
  isError?: boolean;
  bashCmd?: string;
}

interface SessionData {
  file: string;
  path: string;
  duration: number; // minutes
  usage: TokenUsage;
  toolCalls: ToolCall[];
  toolCounts: Record<string, number>;
  cacheCliffs: number;
  redundantReads: { path: string; count: number }[];
  editRetries: { path: string; count: number }[];
  editFailures: number;
  fileOps: Record<string, { reads: number; edits: number }>;
}

function getModel(modelStr: string): string {
  if (!modelStr) return 'opus';
  if (modelStr.includes('opus')) return 'opus';
  if (modelStr.includes('sonnet')) return 'sonnet';
  if (modelStr.includes('haiku')) return 'haiku';
  return 'opus';
}

function findSession(basePath: string, sessionId: string): string | null {
  function scanDir(dir: string): string | null {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = scanDir(fullPath);
          if (found) return found;
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return fullPath;
        }
      }
    } catch {}
    return null;
  }
  return scanDir(basePath);
}

function getJSONLFiles(basePath: string, daysAgo: number): string[] {
  const cutoff = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const files: string[] = [];
  function scanDir(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.jsonl')) {
          try {
            const stat = statSync(fullPath);
            if (stat.mtimeMs >= cutoff) files.push(fullPath);
          } catch {}
        }
      }
    } catch {}
  }
  scanDir(basePath);
  return files;
}

function analyzeSession(filePath: string): SessionData {
  const data: SessionData = {
    file: basename(filePath),
    path: filePath,
    duration: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'opus' },
    toolCalls: [],
    toolCounts: {},
    cacheCliffs: 0,
    redundantReads: [],
    editRetries: [],
    editFailures: 0,
    fileOps: {},
  };

  const fileReads: Record<string, number> = {};
  const fileEdits: Record<string, { count: number; lastTs: string }> = {};
  let lastCacheRatio = 1;
  let firstTs = '', lastTs = '';

  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp || '';
        if (ts && !firstTs) firstTs = ts;
        if (ts) lastTs = ts;

        const usage = entry.usage || entry.message?.usage;
        if (usage) {
          data.usage.inputTokens += usage.input_tokens || 0;
          data.usage.outputTokens += usage.output_tokens || 0;
          data.usage.cacheReadTokens += usage.cache_read_input_tokens || 0;
          data.usage.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          if (entry.model || entry.message?.model) {
            data.usage.model = getModel(entry.model || entry.message?.model);
          }
          const totalInput = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
          if (totalInput > 0) {
            const cacheRatio = (usage.cache_read_input_tokens || 0) / totalInput;
            if (lastCacheRatio > 0.5 && cacheRatio < 0.25) data.cacheCliffs++;
            lastCacheRatio = cacheRatio;
          }
        }

        if (entry.type === 'assistant' && entry.message?.content) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use') {
              const toolName = block.name || '';
              const input = block.input || {};
              const call: ToolCall = { tool: toolName, timestamp: ts };

              // Track bash commands
              if (toolName === 'Bash' && input.command) {
                const cmd = input.command as string;
                const firstWord = cmd.trim().split(/\s+/)[0];
                if (BASH_TO_MCX[firstWord]) call.bashCmd = firstWord;
              }

              // Track file operations
              const fp = input.file_path as string;
              if (fp) {
                call.filePath = fp;
                const fname = basename(fp);
                if (!data.fileOps[fname]) data.fileOps[fname] = { reads: 0, edits: 0 };
                
                if (toolName === 'Read' || toolName === 'mcx_file') {
                  data.fileOps[fname].reads++;
                  fileReads[fname] = (fileReads[fname] || 0) + 1;
                }
                if (toolName === 'Edit' || toolName === 'mcx_edit') {
                  data.fileOps[fname].edits++;
                  const prev = fileEdits[fname];
                  if (prev) {
                    const diff = new Date(ts).getTime() - new Date(prev.lastTs).getTime();
                    if (diff < 120000) prev.count++;
                    else prev.count = 1;
                    prev.lastTs = ts;
                  } else {
                    fileEdits[fname] = { count: 1, lastTs: ts };
                  }
                }
              }

              data.toolCalls.push(call);
              data.toolCounts[toolName] = (data.toolCounts[toolName] || 0) + 1;
            }
          }
        }

        // Track edit failures
        if (entry.type === 'tool_result' || entry.content) {
          const resultContent = entry.content || entry.message?.content;
          const text = typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent);
          if (text.includes('old_string not found') || text.includes('not unique')) {
            data.editFailures++;
          }
        }
      } catch {}
    }
  } catch (e) {
    console.error(`Error reading ${filePath}: ${e}`);
  }

  // Calculate duration
  if (firstTs && lastTs) {
    data.duration = Math.round((new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 60000);
  }

  data.redundantReads = Object.entries(fileReads)
    .filter(([_, count]) => count > 1)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);

  data.editRetries = Object.entries(fileEdits)
    .filter(([_, d]) => d.count > 2)
    .map(([path, d]) => ({ path, count: d.count }))
    .sort((a, b) => b.count - a.count);

  return data;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function formatCost(dollars: number): string {
  if (dollars >= 1) return '$' + dollars.toFixed(2);
  return '$' + dollars.toFixed(4);
}

function calcCost(usage: TokenUsage): number {
  const p = PRICING[usage.model];
  return (usage.inputTokens / 1e6) * p.input +
         (usage.outputTokens / 1e6) * p.output +
         (usage.cacheReadTokens / 1e6) * p.cacheRead +
         (usage.cacheCreationTokens / 1e6) * p.cacheWrite;
}

function printBar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  return '\u2588'.repeat(Math.min(filled, width)) + '\u2591'.repeat(Math.max(width - filled, 0));
}

function printSession(data: SessionData, label?: string) {
  const title = label || `Session: ${data.file.slice(0, 8)}`;
  console.log(`\n\uD83D\uDCCA ${title}`);
  console.log('\u2500'.repeat(60));
  console.log(`Duration: ${Math.floor(data.duration / 60)}h ${data.duration % 60}m | Model: ${data.usage.model}`);

  // Tokens & Cost
  const cost = calcCost(data.usage);
  console.log(`\n\uD83D\uDCB0 Tokens & Cost`);
  console.log(`   Input:       ${formatTokens(data.usage.inputTokens).padStart(10)}`);
  console.log(`   Output:      ${formatTokens(data.usage.outputTokens).padStart(10)}`);
  console.log(`   Cache Read:  ${formatTokens(data.usage.cacheReadTokens).padStart(10)}`);
  console.log(`   Cache Write: ${formatTokens(data.usage.cacheCreationTokens).padStart(10)}`);
  console.log(`   Cost:        ${formatCost(cost).padStart(10)}`);

  // Cache
  const hitRate = data.usage.inputTokens > 0
    ? (data.usage.cacheReadTokens / (data.usage.inputTokens + data.usage.cacheReadTokens) * 100).toFixed(1)
    : '0';
  console.log(`\n\uD83D\uDD04 Cache: ${hitRate}% hit rate, ${data.cacheCliffs} cliffs`);

  // Tool usage
  const sorted = Object.entries(data.toolCounts).sort((a, b) => b[1] - a[1]);
  const totalCalls = sorted.reduce((a, [_, c]) => a + c, 0);
  const mcxCalls = sorted.filter(([t]) => t.includes('mcx_')).reduce((a, [_, c]) => a + c, 0);
  const nativeCalls = sorted.filter(([t]) => NATIVE_TO_MCX[t]).reduce((a, [_, c]) => a + c, 0);
  const adoption = mcxCalls + nativeCalls > 0 ? (mcxCalls / (mcxCalls + nativeCalls) * 100).toFixed(0) : '0';

  console.log(`\n\uD83D\uDCE6 Tools: ${totalCalls} calls, ${adoption}% MCX adoption`);
  const max = sorted[0]?.[1] || 1;
  for (const [tool, count] of sorted.slice(0, 10)) {
    const short = tool.replace('mcp__mcx__', '').replace('mcp__', '');
    const mark = tool.includes('mcx_') ? '\u2713' : NATIVE_TO_MCX[tool] ? '\u26A0' : ' ';
    console.log(`   ${mark} ${short.padEnd(16)} |${printBar(count, max, 15)}| ${count}`);
  }

  // File operations
  const fileOpsSorted = Object.entries(data.fileOps)
    .map(([f, ops]) => ({ file: f, total: ops.reads + ops.edits, ...ops }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  
  if (fileOpsSorted.length > 0) {
    console.log(`\n\uD83D\uDCC1 Top Files (reads + edits)`);
    for (const f of fileOpsSorted) {
      console.log(`   ${f.file.padEnd(30)} ${f.reads}R + ${f.edits}E = ${f.total}`);
    }
  }

  // Problems
  const issues: string[] = [];
  if (data.editFailures > 0) issues.push(`${data.editFailures} edit failures`);
  if (data.redundantReads.length > 0) {
    const total = data.redundantReads.reduce((a, r) => a + r.count, 0);
    issues.push(`${total} redundant reads`);
  }
  if (data.editRetries.length > 0) {
    const total = data.editRetries.reduce((a, r) => a + r.count, 0);
    issues.push(`${total} edit retries`);
  }
  if (data.cacheCliffs > 3) issues.push(`${data.cacheCliffs} cache cliffs`);
  if (nativeCalls > 0) issues.push(`${nativeCalls} native calls`);

  if (issues.length > 0) {
    console.log(`\n\uD83D\uDD34 Issues: ${issues.join(', ')}`);
  }
}

function compareSession(a: SessionData, b: SessionData) {
  console.log(`\n\uD83D\uDD0D Session Comparison`);
  console.log('\u2500'.repeat(60));
  
  const fmt = (v: number, better: 'lower' | 'higher') => {
    const sign = v > 0 ? '+' : '';
    const color = (better === 'lower' && v < 0) || (better === 'higher' && v > 0) ? '\u2705' : '\u274C';
    return `${sign}${v} ${color}`;
  };

  const costA = calcCost(a.usage);
  const costB = calcCost(b.usage);
  const mcxA = Object.entries(a.toolCounts).filter(([t]) => t.includes('mcx_')).reduce((s, [_, c]) => s + c, 0);
  const mcxB = Object.entries(b.toolCounts).filter(([t]) => t.includes('mcx_')).reduce((s, [_, c]) => s + c, 0);
  const nativeA = Object.entries(a.toolCounts).filter(([t]) => NATIVE_TO_MCX[t]).reduce((s, [_, c]) => s + c, 0);
  const nativeB = Object.entries(b.toolCounts).filter(([t]) => NATIVE_TO_MCX[t]).reduce((s, [_, c]) => s + c, 0);
  const adoptA = mcxA + nativeA > 0 ? mcxA / (mcxA + nativeA) * 100 : 0;
  const adoptB = mcxB + nativeB > 0 ? mcxB / (mcxB + nativeB) * 100 : 0;
  const redundantA = a.redundantReads.reduce((s, r) => s + r.count, 0);
  const redundantB = b.redundantReads.reduce((s, r) => s + r.count, 0);

  console.log(`\n                      Session A          Session B          Delta`);
  console.log(`   Duration:          ${String(a.duration).padStart(6)}m          ${String(b.duration).padStart(6)}m          ${fmt(b.duration - a.duration, 'lower')}m`);
  console.log(`   Cost:              ${formatCost(costA).padStart(8)}        ${formatCost(costB).padStart(8)}        ${fmt(Math.round((costB - costA) * 100) / 100, 'lower')}`);
  console.log(`   MCX Adoption:      ${adoptA.toFixed(0).padStart(6)}%          ${adoptB.toFixed(0).padStart(6)}%          ${fmt(Math.round(adoptB - adoptA), 'higher')}%`);
  console.log(`   Edit Failures:     ${String(a.editFailures).padStart(6)}           ${String(b.editFailures).padStart(6)}           ${fmt(b.editFailures - a.editFailures, 'lower')}`);
  console.log(`   Redundant Reads:   ${String(redundantA).padStart(6)}           ${String(redundantB).padStart(6)}           ${fmt(redundantB - redundantA, 'lower')}`);
  console.log(`   Cache Cliffs:      ${String(a.cacheCliffs).padStart(6)}           ${String(b.cacheCliffs).padStart(6)}           ${fmt(b.cacheCliffs - a.cacheCliffs, 'lower')}`);
}

// Main
const searchPath = CUSTOM_PATH || DEFAULT_PROJECTS_DIR;
if (!existsSync(searchPath)) {
  console.error(`Path not found: ${searchPath}`);
  process.exit(1);
}

// Single session mode
if (SESSION_ID) {
  const sessionPath = findSession(searchPath, SESSION_ID);
  if (!sessionPath) {
    console.error(`Session not found: ${SESSION_ID}`);
    process.exit(1);
  }
  
  const sessionA = analyzeSession(sessionPath);
  printSession(sessionA, `Session A: ${SESSION_ID}`);

  if (COMPARE_ID) {
    const comparePath = findSession(searchPath, COMPARE_ID);
    if (!comparePath) {
      console.error(`Compare session not found: ${COMPARE_ID}`);
      process.exit(1);
    }
    const sessionB = analyzeSession(comparePath);
    printSession(sessionB, `Session B: ${COMPARE_ID}`);
    compareSession(sessionA, sessionB);
  }
  
  console.log('');
  process.exit(0);
}

// Multi-session mode (original behavior)
const files = getJSONLFiles(searchPath, DAYS);
console.log(`\n\uD83D\uDCCA Token Analysis (last ${DAYS} days)`);
console.log('\u2500'.repeat(60));
console.log(`Found ${files.length} session files\n`);

if (files.length === 0) {
  console.log('No sessions found.');
  process.exit(0);
}

const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessions: 0, cacheCliffs: 0 };
const toolCounts: Record<string, number> = {};
const allRedundantReads: Record<string, number> = {};
const allEditRetries: Record<string, number> = {};
const costByModel: Record<string, number> = { opus: 0, sonnet: 0, haiku: 0 };

for (const file of files) {
  const session = analyzeSession(file);
  totals.sessions++;
  totals.inputTokens += session.usage.inputTokens;
  totals.outputTokens += session.usage.outputTokens;
  totals.cacheReadTokens += session.usage.cacheReadTokens;
  totals.cacheCreationTokens += session.usage.cacheCreationTokens;
  totals.cacheCliffs += session.cacheCliffs;
  costByModel[session.usage.model] += calcCost(session.usage);
  for (const [tool, count] of Object.entries(session.toolCounts)) {
    toolCounts[tool] = (toolCounts[tool] || 0) + count;
  }
  for (const r of session.redundantReads) {
    allRedundantReads[r.path] = (allRedundantReads[r.path] || 0) + r.count;
  }
  for (const e of session.editRetries) {
    allEditRetries[e.path] = (allEditRetries[e.path] || 0) + e.count;
  }
}

const totalCost = Object.values(costByModel).reduce((a, b) => a + b, 0);
console.log('\uD83D\uDCB0 Token Usage & Cost');
console.log(`   Input:          ${formatTokens(totals.inputTokens).padStart(10)} tokens`);
console.log(`   Output:         ${formatTokens(totals.outputTokens).padStart(10)} tokens`);
console.log(`   Cache Read:     ${formatTokens(totals.cacheReadTokens).padStart(10)} tokens`);
console.log(`   Cache Write:    ${formatTokens(totals.cacheCreationTokens).padStart(10)} tokens`);
console.log(`   Total Cost:     ${formatCost(totalCost).padStart(10)}`);
console.log('');

const cacheHitRate = totals.inputTokens > 0
  ? (totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens) * 100).toFixed(1) : '0';
const cacheSavings = totals.cacheReadTokens * (PRICING.opus.input - PRICING.opus.cacheRead) / 1_000_000;

console.log('\uD83D\uDD04 Cache Efficiency');
console.log(`   Hit Rate:       ${cacheHitRate}%`);
console.log(`   Savings:        ${formatCost(cacheSavings)} (vs uncached)`);
console.log(`   Cache Cliffs:   ${totals.cacheCliffs}`);
console.log('');

const redundantArr = Object.entries(allRedundantReads).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (redundantArr.length > 0) {
  console.log(`\uD83D\uDD01 Redundant Reads (top 5)`);
  for (const [file, count] of redundantArr) console.log(`   ${file.padEnd(30)} ${count}x`);
  console.log('');
}

console.log('\uD83D\uDCC8 Top 15 Tools');
const sortedTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
const maxCalls = sortedTools[0]?.[1] || 1;
for (const [tool, count] of sortedTools) {
  const short = tool.replace('mcp__mcx__', '').replace('mcp__', '');
  const mark = tool.includes('mcx_') ? '\u2713' : NATIVE_TO_MCX[tool] ? '\u26A0' : ' ';
  console.log(`   ${mark} ${short.padEnd(18)} |${printBar(count, maxCalls)}| ${count.toLocaleString()}`);
}
console.log('');

const mcxCalls = Object.entries(toolCounts).filter(([t]) => t.includes('mcx_')).reduce((a, [_, c]) => a + c, 0);
const nativeCalls = Object.entries(toolCounts).filter(([t]) => NATIVE_TO_MCX[t]).reduce((a, [_, c]) => a + c, 0);
const adoption = mcxCalls + nativeCalls > 0 ? (mcxCalls / (mcxCalls + nativeCalls) * 100).toFixed(1) : '0';

console.log(`\uD83C\uDFAF MCX Adoption: ${adoption}% (${mcxCalls} MCX / ${nativeCalls} native)`);
console.log('');
