/**
 * Hybrid Output Filter System (RTK-inspired)
 * 
 * Provides declarative JSON-based filters + hardcoded formatters for complex cases
 */

// ============================================================================
// TYPES
// ============================================================================

/**
 * Declarative filter rule (can be loaded from ~/.mcx/filters/*.json)
 */
export interface FilterRule {
  name: string;
  description?: string;
  matchCommand: string;  // regex to match command
  matchOutput?: string;  // short-circuit if output matches
  pipeline: {
    stripAnsi?: boolean;
    replace?: [string, string][];  // [[pattern, replacement], ...]
    stripLines?: string[];         // remove lines matching any pattern
    keepLines?: string[];          // only keep lines matching any pattern
    truncateLinesAt?: number;      // max chars per line
    headLines?: number;            // keep first N lines
    tailLines?: number;            // keep last N lines
    maxLines?: number;             // total line limit
    onEmpty?: string;              // message when output is empty
  };
}

// ============================================================================
// BUILT-IN DECLARATIVE FILTERS
// ============================================================================

export const BUILTIN_FILTERS: FilterRule[] = [
  {
    name: 'git-status',
    description: 'Strip git hints and empty lines',
    matchCommand: '^git\\s+status',
    pipeline: {
      stripAnsi: true,
      stripLines: [
        '^\\s*$',
        '^\\s*\\(use "',
        '^\\s*\\(create/copy',
      ],
      onEmpty: '✓ Working tree clean',
    },
  },
  {
    name: 'git-add-commit-push',
    description: 'Ultra-compact git confirmations',
    matchCommand: '^git\\s+(add|commit|push|pull|fetch|checkout|switch|merge|rebase)',
    matchOutput: 'Already up to date|Everything up-to-date|nothing to commit',
    pipeline: {
      stripAnsi: true,
      stripLines: [
        '^\\s*$',
        '^\\s*hint:',
        '^\\s*\\(use "',
      ],
      maxLines: 10,
      onEmpty: '✓ Done',
    },
  },
  {
    name: 'biome',
    description: 'Compact Biome lint output',
    matchCommand: '\\bbiome\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: [
        '^\\s*$',
        '^Checked \\d+ file',
        '^Fixed \\d+ file',
        '^The following command',
        '^Run it with',
      ],
      maxLines: 50,
      onEmpty: '✓ biome: ok',
    },
  },
  {
    name: 'eslint',
    description: 'Compact ESLint output',
    matchCommand: '\\beslint\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: [
        '^\\s*$',
        '^✖ \\d+ problem',
        '^\\d+ error.*\\d+ warning',
      ],
      maxLines: 50,
      onEmpty: '✓ eslint: ok',
    },
  },
  {
    name: 'docker-ps',
    description: 'Compact docker container list',
    matchCommand: '^docker\\s+(ps|container\\s+ls)',
    pipeline: {
      stripAnsi: true,
      truncateLinesAt: 120,
      maxLines: 30,
    },
  },
  {
    name: 'pnpm-install',
    description: 'Compact pnpm install',
    matchCommand: '\\bpnpm\\s+(install|i|add)\\b',
    matchOutput: 'Already up to date|Lockfile is up to date',
    pipeline: {
      stripAnsi: true,
      stripLines: [
        '^\\s*$',
        '^Progress:',
        '^Packages:',
        '^\\s+[├└│]',
      ],
      maxLines: 20,
      onEmpty: '✓ pnpm: installed',
    },
  },
  {
    name: 'bun-install',
    description: 'Compact bun install',
    matchCommand: '\\bbun\\s+(install|i|add)\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: [
        '^\\s*$',
        '^bun install',
        '^Resolving:',
      ],
      maxLines: 20,
      onEmpty: '✓ bun: installed',
    },
  },
  {
    name: 'ls-long',
    description: 'Compact long directory listings',
    matchCommand: '\\bls\\s+.*-[la]',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^total\\s+\\d+'],
      maxLines: 40,
    },
  },
  {
    name: 'npm-list',
    description: 'Compact npm/pnpm dependency tree',
    matchCommand: '\\b(npm|pnpm)\\s+(ls|list)\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', 'UNMET DEPENDENCY', 'extraneous', 'invalid:'],
      truncateLinesAt: 100,
      maxLines: 30,
    },
  },
  {
    name: 'env-list',
    description: 'Compact environment variables',
    matchCommand: '^(env|printenv|set)$',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^_=', '^SHLVL=', '^PWD=', '^OLDPWD='],
      truncateLinesAt: 80,
      maxLines: 40,
    },
  },
  {
    name: 'ps-list',
    description: 'Compact process listing',
    matchCommand: '\\bps\\s',
    pipeline: { stripAnsi: true, truncateLinesAt: 120, maxLines: 30 },
  },
];

// ============================================================================
// DECLARATIVE FILTER PIPELINE
// ============================================================================

/**
 * Apply declarative filter pipeline to output
 */
export function applyDeclarativeFilter(
  cmd: string, 
  output: string, 
  rules: FilterRule[] = BUILTIN_FILTERS
): string | null {
  // Find matching rule
  const rule = rules.find(r => new RegExp(r.matchCommand, 'i').test(cmd));
  if (!rule) return null;
  
  let result = output;
  const p = rule.pipeline;
  
  // Stage 1: strip ANSI
  if (p.stripAnsi) {
    result = result.replace(/\x1b\[[0-9;]*m/g, '');
  }
  
  // Stage 2: replace
  if (p.replace) {
    for (const [pattern, replacement] of p.replace) {
      result = result.replace(new RegExp(pattern, 'gm'), replacement);
    }
  }
  
  // Stage 3: match_output short-circuit
  if (rule.matchOutput && new RegExp(rule.matchOutput, 'i').test(result)) {
    return p.onEmpty || '✓ ok';
  }
  
  // Stage 4: strip/keep lines
  let lines = result.split('\n');
  if (p.stripLines) {
    const patterns = p.stripLines.map(pat => new RegExp(pat));
    lines = lines.filter(l => !patterns.some(pat => pat.test(l)));
  }
  if (p.keepLines) {
    const patterns = p.keepLines.map(pat => new RegExp(pat));
    lines = lines.filter(l => patterns.some(pat => pat.test(l)));
  }
  
  // Stage 5: truncate lines
  if (p.truncateLinesAt) {
    const max = p.truncateLinesAt;
    lines = lines.map(l => l.length > max ? l.slice(0, max) + '…' : l);
  }
  
  // Stage 6: head/tail (60/40 style)
  if (p.headLines && p.tailLines) {
    const total = p.headLines + p.tailLines;
    if (lines.length > total) {
      const head = lines.slice(0, p.headLines);
      const tail = lines.slice(-p.tailLines);
      const hidden = lines.length - total;
      lines = [...head, `... (${hidden} lines hidden) ...`, ...tail];
    }
  } else if (p.headLines && lines.length > p.headLines) {
    const hidden = lines.length - p.headLines;
    lines = [...lines.slice(0, p.headLines), `... (+${hidden} more lines)`];
  } else if (p.tailLines && lines.length > p.tailLines) {
    const hidden = lines.length - p.tailLines;
    lines = [`(${hidden} lines before) ...`, ...lines.slice(-p.tailLines)];
  }
  
  // Stage 7: max lines
  if (p.maxLines && lines.length > p.maxLines) {
    const hidden = lines.length - p.maxLines;
    lines = [...lines.slice(0, p.maxLines), `... (+${hidden} lines)`];
  }
  
  result = lines.join('\n').trim();
  
  // Stage 8: on empty
  if (!result && p.onEmpty) {
    return p.onEmpty;
  }
  
  return result || null;
}

// ============================================================================
// HARDCODED FORMATTERS (for complex parsing)
// ============================================================================

/**
 * Compact path helper (reused from serve.ts pattern)
 */
function compactPath(filePath: string, maxLen: number = 50): string {
  if (filePath.length <= maxLen) return filePath;
  
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 2) return filePath.slice(-maxLen);
  
  const file = parts.pop()!;
  const dir = parts.pop()!;
  const prefix = parts.slice(0, 1).join('/');
  
  const result = `${prefix}/.../${dir}/${file}`;
  return result.length <= maxLen ? result : `.../${dir}/${file}`.slice(-maxLen);
}

/**
 * Format git diff output - group changes by file with +/- summary
 */
export function formatGitDiff(output: string): string | null {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  
  // Check if this looks like diff output
  if (!lines.some(l => l.startsWith('diff --git') || l.startsWith('@@'))) {
    return null;
  }
  
  const files: { name: string; adds: number; dels: number }[] = [];
  let current: typeof files[0] | null = null;
  
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+) b\//);
      if (match) {
        current = { name: match[1], adds: 0, dels: 0 };
        files.push(current);
      }
    } else if (line.startsWith('+') && !line.startsWith('+++') && current) {
      current.adds++;
    } else if (line.startsWith('-') && !line.startsWith('---') && current) {
      current.dels++;
    }
  }
  
  if (files.length === 0) return null;
  
  const result: string[] = [`${files.length} file${files.length > 1 ? 's' : ''} changed:`];
  for (const f of files.slice(0, 15)) {
    result.push(`  ${compactPath(f.name, 50)} (+${f.adds} -${f.dels})`);
  }
  if (files.length > 15) {
    result.push(`  ... +${files.length - 15} more files`);
  }
  
  const totalAdds = files.reduce((s, f) => s + f.adds, 0);
  const totalDels = files.reduce((s, f) => s + f.dels, 0);
  result.push(`\nTotal: +${totalAdds} -${totalDels}`);
  
  return result.join('\n');
}

/**
 * Format test output - extract failures only (vitest, jest, playwright)
 */
export function formatTestOutput(output: string): string | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  
  // Detect test framework
  const isTest = /vitest|jest|playwright|PASS|FAIL|✓|✗|passed|failed/.test(clean);
  if (!isTest) return null;
  
  const lines = clean.split('\n');
  const failures: string[] = [];
  const summary: string[] = [];
  let inFailure = false;
  
  for (const line of lines) {
    // Detect failure start
    if (/FAIL|✗|✘|Error:|AssertionError|expect\(/.test(line)) {
      inFailure = true;
      failures.push(line.trim());
    } else if (inFailure) {
      if (line.trim() && !line.match(/^\s*at\s/) && failures.length < 30) {
        failures.push('  ' + line.trim());
      }
      if (/^(PASS|FAIL|✓|✗|Tests:|Test Files:)/.test(line.trim())) {
        inFailure = false;
      }
    }
    
    // Capture summary
    if (/^(Tests?:|Test Files?:|Duration:|\d+ passed|\d+ failed)/.test(line.trim())) {
      summary.push(line.trim());
    }
  }
  
  if (failures.length === 0 && summary.length > 0) {
    return '✓ All tests passed\n' + summary.slice(0, 3).join('\n');
  }
  
  if (failures.length > 0) {
    const result = failures.slice(0, 20);
    if (failures.length > 20) result.push(`... +${failures.length - 20} more`);
    if (summary.length > 0) result.push('', ...summary.slice(0, 3));
    return result.join('\n');
  }
  
  return null;
}

/**
 * Format TypeScript/lint output - group errors by file
 */
export function formatLintOutput(cmd: string, output: string): string | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  
  // Parse multiple error formats:
  // - eslint/biome: file:line:col: message
  // - tsc: file(line,col): message
  const eslintPattern = /^(.+?):(\d+):(\d+):\s*(.+)$/;
  const tscPattern = /^(.+?)\((\d+),(\d+)\):\s*(.+)$/;
  const byFile = new Map<string, { line: number; msg: string }[]>();
  
  for (const line of clean.split('\n')) {
    const match = line.match(eslintPattern) || line.match(tscPattern);
    if (match) {
      const [, file, lineNum, , msg] = match;
      const shortFile = compactPath(file, 40);
      if (!byFile.has(shortFile)) byFile.set(shortFile, []);
      byFile.get(shortFile)!.push({ line: parseInt(lineNum), msg: msg.slice(0, 80) });
    }
  }
  
  if (byFile.size === 0) return null;
  
  const result: string[] = [];
  let totalErrors = 0;
  
  for (const [file, errors] of byFile) {
    totalErrors += errors.length;
    result.push(`${file}:`);
    for (const e of errors.slice(0, 5)) {
      result.push(`  L${e.line}: ${e.msg}`);
    }
    if (errors.length > 5) result.push(`  +${errors.length - 5} more`);
  }
  
  result.unshift(`${totalErrors} error${totalErrors > 1 ? 's' : ''} in ${byFile.size} file${byFile.size > 1 ? 's' : ''}:\n`);
  
  return result.join('\n');
}

/**
 * Format docker logs - deduplicate repeated lines
 */
export function formatDockerLogs(output: string): string | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n').filter(l => l.trim());
  
  if (lines.length < 5) return null;
  
  const seen = new Map<string, number>();
  const order: string[] = [];
  
  for (const line of lines) {
    // Normalize timestamps
    const normalized = line.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/, '');
    if (!seen.has(normalized)) order.push(normalized);
    seen.set(normalized, (seen.get(normalized) || 0) + 1);
  }
  
  // Only format if meaningful dedup
  if (lines.length - order.length < 3) return null;
  
  const result: string[] = [`${lines.length} lines (${order.length} unique):\n`];
  for (const line of order.slice(0, 30)) {
    const count = seen.get(line)!;
    const truncated = line.slice(0, 100);
    result.push(count > 1 ? `${truncated} (x${count})` : truncated);
  }
  if (order.length > 30) result.push(`... +${order.length - 30} more`);
  
  return result.join('\n');
}

/**
 * Smart 60/40 truncation - preserve head and tail
 */
export function smartTruncate(output: string, maxChars: number = 4000): string {
  if (output.length <= maxChars) return output;
  
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  
  const head = output.slice(0, headLen);
  const tail = output.slice(-tailLen);
  const hidden = output.length - maxChars;
  
  return `${head}\n\n... (${hidden} chars hidden) ...\n\n${tail}`;
}

// ============================================================================
// MAIN HYBRID FILTER
// ============================================================================

/**
 * Extract the main command from compound commands (cd x && cmd, cmd1 && cmd2)
 * For filter matching, we want the last meaningful command.
 */
function extractMainCommand(cmd: string): string {
  // Split by && and get the last non-cd command
  const parts = cmd.split(/\s*&&\s*/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i].trim();
    if (!part.startsWith('cd ')) {
      return part;
    }
  }
  return parts[parts.length - 1]?.trim() || cmd;
}

/**
 * Apply hybrid filter - tries declarative, hardcoded, grep detection, then truncation
 */
export function applyHybridFilter(
  cmd: string, 
  output: string,
  detectGrepOutput?: (output: string) => string | null
): string {
  // Extract main command for matching (handles "cd x && git status")
  const mainCmd = extractMainCommand(cmd);
  
  // 1. Try declarative filters FIRST (always, regardless of size)
  const declarative = applyDeclarativeFilter(mainCmd, output);
  if (declarative) return declarative;
  
  // Skip fallbacks if output is small (no point in truncating/formatting)
  if (output.length < 500) return output;
  
  // 2. Try hardcoded formatters
  if (/\bgit\s+(diff|show)\b/.test(mainCmd)) {
    const formatted = formatGitDiff(output);
    if (formatted) return formatted;
  }
  
  if (/\b(vitest|jest|playwright|test)\b/i.test(mainCmd)) {
    const formatted = formatTestOutput(output);
    if (formatted) return formatted;
  }
  
  if (/\b(tsc|eslint|biome|lint)\b/i.test(mainCmd)) {
    const formatted = formatLintOutput(cmd, output);
    if (formatted) return formatted;
  }
  
  if (/\bdocker\s+logs\b/.test(mainCmd)) {
    const formatted = formatDockerLogs(output);
    if (formatted) return formatted;
  }
  
  // 3. Try grep detection (passed in from serve.ts)
  if (detectGrepOutput) {
    const grepFormatted = detectGrepOutput(output);
    if (grepFormatted) return grepFormatted;
  }
  
  // 4. Fallback: smart 60/40 truncation
  if (output.length > 4000) {
    return smartTruncate(output, 4000);
  }
  
  return output;
}
