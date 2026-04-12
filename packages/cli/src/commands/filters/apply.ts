/**
 * Filter Application
 * 
 * Core functions for applying declarative filters to command output.
 */

import type { FilterRule } from "./types.js";
import { BUILTIN_FILTERS } from "./rules.js";

// ANSI escape code regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Apply a declarative filter rule to command output.
 * Returns filtered output or null if no rule matches.
 */
export function applyDeclarativeFilter(
  cmd: string, 
  output: string, 
  rules: FilterRule[] = BUILTIN_FILTERS
): string | null {
  // Find matching rule (use pre-compiled regex if available)
  const rule = rules.find(r => 
    r._compiled ? r._compiled.matchCommand.test(cmd) : new RegExp(r.matchCommand, 'i').test(cmd)
  );
  if (!rule) return null;
  
  let result = output;
  const p = rule.pipeline;
  const compiled = rule._compiled;
  
  // Stage 1: strip ANSI
  if (p.stripAnsi) {
    result = result.replace(ANSI_REGEX, '');
  }
  
  // Stage 2: apply replacements
  if (compiled?.replace) {
    for (const [regex, rep] of compiled.replace) {
      result = result.replace(regex, rep);
    }
  } else if (p.replace) {
    for (const [pat, rep] of p.replace) {
      result = result.replace(new RegExp(pat, 'gm'), rep);
    }
  }
  
  // Stage 3: filter lines
  const lines = result.split('\n');
  let filtered = lines;
  
  if (compiled?.keepLines) {
    filtered = lines.filter(line => compiled.keepLines!.some(r => r.test(line)));
  } else if (p.keepLines) {
    const keepRegexes = p.keepLines.map(pat => new RegExp(pat));
    filtered = lines.filter(line => keepRegexes.some(r => r.test(line)));
  }
  
  if (compiled?.stripLines) {
    filtered = filtered.filter(line => !compiled.stripLines!.some(r => r.test(line)));
  } else if (p.stripLines) {
    const stripRegexes = p.stripLines.map(pat => new RegExp(pat));
    filtered = filtered.filter(line => !stripRegexes.some(r => r.test(line)));
  }
  
  // Stage 4: limit lines
  if (p.maxLines && filtered.length > p.maxLines) {
    filtered = filtered.slice(0, p.maxLines);
    filtered.push(`... (${lines.length - p.maxLines} more lines)`);
  }
  
  // Stage 5: handle empty result
  result = filtered.join('\n').trim();
  if (!result && p.onEmpty) {
    return p.onEmpty;
  }
  
  // Stage 6: truncate if needed
  if (p.truncateAt && result.length > p.truncateAt) {
    result = result.substring(0, p.truncateAt) + '...';
  }
  
  return result || null;
}

/**
 * Apply hybrid filtering: try declarative first, then formatters.
 */
export function applyHybridFilter(
  cmd: string,
  output: string,
  formatters?: ((output: string) => string | null)[]
): string {
  // Try declarative filter first
  const declarative = applyDeclarativeFilter(cmd, output);
  if (declarative !== null) return declarative;
  
  // Try custom formatters
  if (formatters) {
    for (const fmt of formatters) {
      const result = fmt(output);
      if (result !== null) return result;
    }
  }
  
  // No filter matched - return original (stripped of ANSI)
  return output.replace(ANSI_REGEX, '');
}
