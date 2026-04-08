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
  {
    name: 'cargo-test',
    description: 'Rust test failures only',
    matchCommand: '\\bcargo\\s+(test|t)\\b',
    matchOutput: 'test result: ok',
    pipeline: {
      stripAnsi: true,
      keepLines: ['^test .* FAILED', '^failures:', '^    ', '^thread .* panicked', '^error\\[', 'test result:'],
      maxLines: 50,
      onEmpty: '✓ cargo test: passed',
    },
  },
  {
    name: 'pytest',
    description: 'Python test failures only',
    matchCommand: '\\b(pytest|py\\.test)\\b',
    matchOutput: 'passed',
    pipeline: {
      stripAnsi: true,
      keepLines: ['^FAILED', '^ERROR', '^=+ FAILURES', '^=+ ERRORS', '^    ', '^E\\s+', '^>\\s+', 'passed|failed|error'],
      maxLines: 50,
      onEmpty: '✓ pytest: passed',
    },
  },
  {
    name: 'go-test',
    description: 'Go test failures only',
    matchCommand: '\\bgo\\s+test\\b',
    matchOutput: '^ok\\s+',
    pipeline: {
      stripAnsi: true,
      keepLines: ['^---\\s*FAIL', '^FAIL', '^panic:', '\\s+Error:', '\\s+Got:', '\\s+Want:', 'coverage:'],
      maxLines: 50,
      onEmpty: '✓ go test: passed',
    },
  },
  {
    name: 'ruff-check',
    description: 'Compact ruff linter output',
    matchCommand: '\\bruff\\s+(check|\\.)\\b',
    matchOutput: 'All checks passed',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^Found \\d+ error'],
      truncateLinesAt: 100,
      maxLines: 40,
      onEmpty: '✓ ruff: ok',
    },
  },
  {
    name: 'npm-test',
    description: 'JS test failures only',
    matchCommand: '\\b(npm|pnpm|bun)\\s+(test|t)\\b',
    pipeline: {
      stripAnsi: true,
      keepLines: ['^\\s*(FAIL|PASS|✓|✗|×)', '^\\s+●', '^\\s+at\\s', 'Tests:', 'failed', 'passed'],
      maxLines: 50,
      onEmpty: '✓ tests: passed',
    },
  },
  {
    name: 'tree',
    description: 'Compact tree output',
    matchCommand: '\\btree\\b',
    pipeline: { stripAnsi: true, maxLines: 50 },
  },
  // GitHub CLI
  {
    name: 'gh-pr-list',
    description: 'Compact PR listing',
    matchCommand: '\\bgh\\s+pr\\s+(list|ls)\\b',
    pipeline: { stripAnsi: true, truncateLinesAt: 95, maxLines: 25 },
  },
  {
    name: 'gh-pr-view',
    description: 'Compact PR details',
    matchCommand: '\\bgh\\s+pr\\s+(view|show)\\b',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*$', '^labels:', '^projects:', '^milestone:'],
      maxLines: 35,
    },
  },
  {
    name: 'gh-issue-list',
    description: 'Compact issue listing',
    matchCommand: '\\bgh\\s+issue\\s+(list|ls)\\b',
    pipeline: { stripAnsi: true, truncateLinesAt: 90, maxLines: 25 },
  },
  {
    name: 'gh-run-list',
    description: 'Compact workflow runs',
    matchCommand: '\\bgh\\s+run\\s+(list|ls|view)\\b',
    pipeline: { stripAnsi: true, truncateLinesAt: 110, maxLines: 22 },
  },
  {
    name: 'gh-pr-checks',
    description: 'Compact PR checks',
    matchCommand: '\\bgh\\s+pr\\s+checks\\b',
    pipeline: { stripAnsi: true, maxLines: 20 },
  },
  // kubectl
  {
    name: 'kubectl-get',
    description: 'Compact k8s resources',
    matchCommand: '\\bkubectl\\s+(get|describe)\\b',
    pipeline: { stripAnsi: true, truncateLinesAt: 115, maxLines: 45 },
  },
  {
    name: 'kubectl-logs',
    description: 'Compact pod logs',
    matchCommand: '\\bkubectl\\s+logs\\b',
    pipeline: { stripAnsi: true, maxLines: 55 },
  },
  // AWS CLI
  {
    name: 'aws-cli',
    description: 'Compact AWS output',
    matchCommand: '\\baws\\s+',
    pipeline: { stripAnsi: true, truncateLinesAt: 105, maxLines: 42 },
  },
  // curl/wget
  {
    name: 'curl-wget',
    description: 'Strip progress bars',
    matchCommand: '\\b(curl|wget)\\s+',
    pipeline: {
      stripAnsi: true,
      stripLines: ['^\\s*%', '^\\s*\\d+\\s+\\d+', '^--', '^\\s*$'],
      maxLines: 60,
    },
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
  const diffLines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  
  if (!diffLines.some(l => l.startsWith('diff --git') || l.startsWith('@@'))) {
    return null;
  }
  
  const MAX_CHANGES = 10;
  type FileChange = { name: string; adds: number; dels: number; changes: string[] };
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  
  for (const ln of diffLines) {
    if (ln.startsWith('diff --git')) {
      const m = ln.match(/diff --git a\/(.+) b\//);
      if (m) {
        cur = { name: m[1], adds: 0, dels: 0, changes: [] };
        files.push(cur);
      }
    } else if (cur && ln.startsWith('+') && !ln.startsWith('+++')) {
      cur.adds++;
      cur.changes = [...cur.changes, ln];
    } else if (cur && ln.startsWith('-') && !ln.startsWith('---')) {
      cur.dels++;
      cur.changes = [...cur.changes, ln];
    }
  }
  
  if (files.length === 0) return null;
  
  const out: string[] = [];
  for (const f of files) {
    out.push(`[file] ${compactPath(f.name, 50)} (+${f.adds} -${f.dels})`);
    const visible = f.changes.slice(0, MAX_CHANGES);
    visible.forEach(c => {
      out.push(`  ${c.length > 100 ? c.slice(0, 100) + '...' : c}`);
    });
    if (f.changes.length > MAX_CHANGES) {
      out.push(`  ... +${f.changes.length - MAX_CHANGES} more`);
    }
  }
  
  const totAdd = files.reduce((s, f) => s + f.adds, 0);
  const totDel = files.reduce((s, f) => s + f.dels, 0);
  out.push(`\nTotal: +${totAdd} -${totDel}`);
  
  return out.join('\n');
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
 * Format ls -la output - compact with sizes (RTK style)
 * Dirs first with /, then files with size, summary at end
 */
export function formatLsOutput(output: string): string | null {
  const lines = output.split('\n').filter(l => l.trim());
  
  const dirs: string[] = [];
  const files: Array<{ name: string; size: string; ext: string }> = [];
  const byExt = new Map<string, number>();
  
  for (const line of lines) {
    // Skip total, empty, . and ..
    if (line.startsWith('total ') || !line.trim()) continue;
    
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    
    const name = parts.slice(8).join(' ');
    if (name === '.' || name === '..') continue;
    
    const perms = parts[0];
    const isDir = perms.startsWith('d');
    
    if (isDir) {
      dirs.push(name);
    } else if (perms.startsWith('-') || perms.startsWith('l')) {
      const bytes = parseInt(parts[4]) || 0;
      const size = bytes >= 1048576 
        ? `${(bytes / 1048576).toFixed(1)}M`
        : bytes >= 1024 
          ? `${(bytes / 1024).toFixed(1)}K`
          : `${bytes}B`;
      
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : 'no ext';
      byExt.set(ext, (byExt.get(ext) || 0) + 1);
      files.push({ name, size, ext });
    }
  }
  
  if (dirs.length === 0 && files.length === 0) return '(empty)';
  
  const result: string[] = [];
  
  // Dirs first
  for (const d of dirs) {
    result.push(`${d}/`);
  }
  
  // Files with size
  for (const f of files) {
    result.push(`${f.name}  ${f.size}`);
  }
  
  // Summary
  let summary = `\n${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const extCounts = [...byExt.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(', ');
    summary += ` (${extCounts})`;
  }
  result.push(summary);
  
  return result.join('\n');
}

/**

 * Format JSON output - show structure without values (like RTK json command)
 */
export function formatJsonStructure(output: string): string | null {
  try {
    const parsed = JSON.parse(output.trim());
    return formatJsonObject(parsed, '', 0);
  } catch {
    return null;
  }
}

function formatJsonObject(obj: any, path: string, depth: number): string {
  if (depth > 4) return `${path}: ...`;
  
  const lines: string[] = [];
  const type = Array.isArray(obj) ? 'array' : typeof obj;
  
  if (type === 'object' && obj !== null) {
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      lines.push(`${path || 'root'}: {}`);
    } else {
      lines.push(`${path || 'root'}: {${keys.length} keys}`);
      for (const key of keys.slice(0, 10)) {
        const child = formatJsonObject(obj[key], key, depth + 1);
        lines.push('  ' + child);
      }
      if (keys.length > 10) lines.push(`  ... +${keys.length - 10} more keys`);
    }
  } else if (type === 'array') {
    const arr = obj as any[];
    if (arr.length === 0) {
      lines.push(`${path || 'root'}: []`);
    } else {
      const itemType = typeof arr[0];
      lines.push(`${path || 'root'}: [${arr.length} ${itemType}s]`);
      if (itemType === 'object' && arr[0] !== null) {
        const sample = formatJsonObject(arr[0], '[0]', depth + 1);
        lines.push('  ' + sample);
      }
    }
  } else {
    lines.push(`${path}: ${type}`);
  }
  
  return lines.join('\n');
}

/**
 * Deduplicate log lines with counts (like RTK log command)
 */
export function formatLogOutput(output: string): string | null {
  const lines = output.split('\n').filter(l => l.trim());
  if (lines.length < 10) return null;
  
  // Normalize timestamps and count occurrences
  const seen = new Map<string, { count: number; first: string }>();
  const order: string[] = [];
  
  for (const line of lines) {
    // Strip common timestamp patterns
    const normalized = line
      .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?\s*/g, '')
      .replace(/^\[\d{4}-\d{2}-\d{2}.*?\]\s*/g, '')
      .replace(/^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s*/g, '')
      .trim();
    
    if (!normalized) continue;
    
    if (!seen.has(normalized)) {
      order.push(normalized);
      seen.set(normalized, { count: 0, first: line.slice(0, 30) });
    }
    seen.get(normalized)!.count++;
  }
  
  // Only format if meaningful deduplication
  const deduped = lines.length - order.length;
  if (deduped < 5) return null;
  
  const result: string[] = [`${lines.length} lines → ${order.length} unique:`];
  for (const line of order.slice(0, 40)) {
    const info = seen.get(line)!;
    const truncated = line.slice(0, 90);
    result.push(info.count > 1 ? `${truncated} (×${info.count})` : truncated);
  }
  if (order.length > 40) result.push(`... +${order.length - 40} more`);
  
  return result.join('\n');
}

// ============================================================================
// GITHUB CLI FORMATTERS (RTK-style JSON parsing)
// ============================================================================

/** Format gh pr list - parse JSON, show compact list */
export function formatGhPrList(output: string): string | null {
  try {
    const prs = JSON.parse(output.trim());
    if (!Array.isArray(prs) || prs.length === 0) return null;
    const result = ['Pull Requests'];
    for (const pr of prs.slice(0, 20)) {
      const icon = pr.state === 'MERGED' ? '✓' : pr.state === 'CLOSED' ? '✗' : '○';
      result.push(`  ${icon} #${pr.number || '?'} ${(pr.title || '').slice(0, 60)} (${pr.author?.login || '?'})`);
    }
    if (prs.length > 20) result.push(`  ... +${prs.length - 20} more`);
    return result.join('\n');
  } catch (e) { return null; }
}

/** Format gh issue list - parse JSON, show compact list */
export function formatGhIssueList(output: string): string | null {
  try {
    const issues = JSON.parse(output.trim());
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const out = ['Issues'];
    for (const i of issues.slice(0, 20)) {
      const icon = i.state === 'CLOSED' ? '✓' : '○';
      const labels = (i.labels || []).map((l: any) => l.name).slice(0, 2).join(', ');
      out.push(`  ${icon} #${i.number || '?'} ${(i.title || '').slice(0, 60)}${labels ? ` [${labels}]` : ''}`);
    }
    if (issues.length > 20) out.push(`  ... +${issues.length - 20} more`);
    return out.join('\n');
  } catch (_) { return null; }
}

/** Format gh run list - parse JSON, show workflow runs */
export function formatGhRunList(output: string): string | null {
  try {
    const runs = JSON.parse(output.trim());
    if (!Array.isArray(runs) || runs.length === 0) return null;
    const lines: string[] = ['Workflow Runs'];
    for (const r of runs.slice(0, 15)) {
      const icon = r.conclusion === 'success' ? '✓' : r.conclusion === 'failure' ? '✗' : r.status === 'in_progress' ? '●' : '○';
      lines.push(`  ${icon} ${r.databaseId || r.id || '?'} ${(r.name || r.workflowName || '').slice(0, 40)} (${r.headBranch || ''})`);
    }
    if (runs.length > 15) lines.push(`  ... +${runs.length - 15} more`);
    return lines.join('\n');
  } catch (err) { return null; }
}

/**

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

  // 2. JSON structure detection (applies to any output that looks like JSON)
  // Run this BEFORE returning declarative result so JSON is always formatted
  const baseOutput = declarative || output;
  const trimmed = baseOutput.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const jsonFormatted = formatJsonStructure(baseOutput);
    if (jsonFormatted) return jsonFormatted;
  }

  // Return declarative result if not JSON
  if (declarative) return declarative;

  // Skip fallbacks if output is small (no point in truncating/formatting)
  if (output.length < 500) return output;

  // 3. Try hardcoded formatters
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

  // ls -la output (compact with sizes)
  if (/\bls\s+.*-[la]/.test(mainCmd)) {
    const lsFormatted = formatLsOutput(output);
    if (lsFormatted) return lsFormatted;
  }

  // GitHub CLI - parse JSON output
  if (/\bgh\s+pr\s+list\b/.test(mainCmd)) {
    const ghFormatted = formatGhPrList(output);
    if (ghFormatted) return ghFormatted;
  }
  if (/\bgh\s+issue\s+list\b/.test(mainCmd)) {
    const ghIssues = formatGhIssueList(output);
    if (ghIssues) return ghIssues;
  }
  if (/\bgh\s+run\s+list\b/.test(mainCmd)) {
    const ghRuns = formatGhRunList(output);
    if (ghRuns) return ghRuns;
  }

  // Log deduplication (for tail, logs commands)
  if (/\b(tail|logs?)\b/i.test(mainCmd)) {
    const logFormatted = formatLogOutput(output);
    if (logFormatted) return logFormatted;
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
