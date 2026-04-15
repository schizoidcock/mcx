/**
 * Output Formatters
 * 
 * Specialized formatters for complex output types:
 * - Git diffs
 * - Test results
 * - Lint output
 * - Docker logs
 * - File listings
 * - JSON structures
 * - Log output
 * - GitHub CLI output
 */

import { compactPath } from "../utils/paths.js";

// ANSI escape code regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// ============================================================================
// GIT
// ============================================================================

/** Format git diff - compact view with file summary */
export function formatGitDiff(output: string): string | null {
  const diffLines = output.replace(ANSI_REGEX, '').split('\n');
  
  if (!diffLines.some(l => l.startsWith('diff --git') || l.startsWith('@@'))) {
    return null;
  }
  
  const MAX_CHANGES = 10;
  type FileChange = { name: string; adds: number; dels: number; changes: string[] };
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  
  for (const ln of diffLines) {
    if (ln.startsWith('diff --git')) {
      const match = ln.match(/b\/(.+)$/);
      if (match) {
        cur = { name: match[1], adds: 0, dels: 0, changes: [] };
        files.push(cur);
      }
    } else if (cur) {
      if (ln.startsWith('+') && !ln.startsWith('+++')) {
        cur.adds++;
        if (cur.changes.length < MAX_CHANGES) cur.changes.push(ln);
      } else if (ln.startsWith('-') && !ln.startsWith('---')) {
        cur.dels++;
        if (cur.changes.length < MAX_CHANGES) cur.changes.push(ln);
      }
    }
  }
  
  if (files.length === 0) return null;
  
  const summary = files.map(f => 
    `${compactPath(f.name)} (+${f.adds}/-${f.dels})`
  ).join('\n');
  
  return `${files.length} file(s) changed:\n${summary}`;
}

// ============================================================================
// TESTING
// ============================================================================

/** Format test output - extract pass/fail summary */
export function formatTestOutput(output: string): string | null {
  const clean = output.replace(ANSI_REGEX, '');
  
  // Jest/Vitest pattern
  const jestMatch = clean.match(/Tests:\s+(\d+)\s+passed|(\d+)\s+failed/);
  if (jestMatch) {
    const passed = jestMatch[1] || '0';
    const failed = jestMatch[2] || '0';
    return `Tests: ${passed} passed, ${failed} failed`;
  }
  
  // Pytest pattern
  const pytestMatch = clean.match(/(\d+) passed|(\d+) failed/);
  if (pytestMatch) {
    return clean.split('\n').slice(-5).join('\n').trim();
  }
  
  return null;
}

// ============================================================================
// LINTING
// ============================================================================

/** Format lint output - extract error summary */
export function formatLintOutput(cmd: string, output: string): string | null {
  const clean = output.replace(ANSI_REGEX, '');
  
  // ESLint/Biome pattern
  const errorMatch = clean.match(/(\d+)\s+(error|problem)/i);
  const warnMatch = clean.match(/(\d+)\s+warning/i);
  
  if (errorMatch || warnMatch) {
    const errors = errorMatch ? errorMatch[1] : '0';
    const warnings = warnMatch ? warnMatch[1] : '0';
    return `Lint: ${errors} errors, ${warnings} warnings`;
  }
  
  return null;
}

// ============================================================================
// DOCKER
// ============================================================================

/** Format docker logs - tail with timestamps */
export function formatDockerLogs(output: string): string | null {
  const clean = output.replace(ANSI_REGEX, '');
  const lines = clean.split('\n').filter(l => l.trim());
  
  if (lines.length === 0) return null;
  
  // Take last 20 lines
  const tail = lines.slice(-20);
  return tail.join('\n');
}

// ============================================================================
// FILE LISTINGS
// ============================================================================

/** Format ls output - compact table */
export function formatLsOutput(output: string): string | null {
  const clean = output.replace(ANSI_REGEX, '');
  const lines = clean.split('\n').filter(l => l.trim());
  
  if (lines.length <= 10) return null;
  
  // Truncate long listings
  const head = lines.slice(0, 10);
  return [...head, `... (${lines.length - 10} more files)`].join('\n');
}

// ============================================================================
// JSON
// ============================================================================

/** Format JSON structure - summarize large objects */
export function formatJsonStructure(output: string): string | null {
  try {
    const parsed = JSON.parse(output.trim());
    
    if (Array.isArray(parsed)) {
      if (parsed.length > 10) {
        return `Array[${parsed.length}]: ${JSON.stringify(parsed.slice(0, 3))}...`;
      }
    } else if (typeof parsed === 'object' && parsed !== null) {
      const keys = Object.keys(parsed);
      if (keys.length > 10) {
        return `Object{${keys.length} keys}: ${keys.slice(0, 5).join(', ')}...`;
      }
    }
    
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// LOGS
// ============================================================================

/** Format log output - extract relevant lines */
export function formatLogOutput(output: string): string | null {
  const clean = output.replace(ANSI_REGEX, '');
  const lines = clean.split('\n');
  
  // Filter to error/warning lines
  const relevant = lines.filter(l => 
    /error|warn|fail|exception/i.test(l)
  );
  
  if (relevant.length === 0) return null;
  if (relevant.length > 20) {
    return [...relevant.slice(0, 20), `... (${relevant.length - 20} more)`].join('\n');
  }
  
  return relevant.join('\n');
}

// ============================================================================
// GITHUB CLI
// ============================================================================

/** Format gh pr list - parse JSON, show compact list */
export function formatGhPrList(output: string): string | null {
  try {
    const prs = JSON.parse(output.trim());
    if (!Array.isArray(prs) || prs.length === 0) return '(no PRs)';
    
    return prs.slice(0, 10).map((pr: { number: number; title: string; state: string }) =>
      `#${pr.number} ${pr.title} [${pr.state}]`
    ).join('\n');
  } catch {
    return null;
  }
}

/** Format gh issue list */
export function formatGhIssueList(output: string): string | null {
  try {
    const issues = JSON.parse(output.trim());
    if (!Array.isArray(issues) || issues.length === 0) return '(no issues)';
    
    return issues.slice(0, 10).map((i: { number: number; title: string; state: string }) =>
      `#${i.number} ${i.title} [${i.state}]`
    ).join('\n');
  } catch {
    return null;
  }
}

/** Format gh run list - workflow runs */
export function formatGhRunList(output: string): string | null {
  try {
    const runs = JSON.parse(output.trim());
    if (!Array.isArray(runs) || runs.length === 0) return '(no runs)';
    
    return runs.slice(0, 10).map((r: { status: string; conclusion: string; name: string }) =>
      `${r.status === 'completed' ? (r.conclusion === 'success' ? '✓' : '✗') : '○'} ${r.name}`
    ).join('\n');
  } catch {
    return null;
  }
}
