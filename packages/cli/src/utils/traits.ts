/**
 * Trait analysis utilities for MCX
 * Pre-execution analysis to detect potentially dangerous, slow, or stateful operations
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type TraitType =
  | 'stateful'
  | 'destructive'
  | 'external'
  | 'slow'
  | 'n_plus_one'
  | 'rate_limit_risk'
  | 'infinite_loop';

export type Severity = 'info' | 'warning' | 'caution';
export type Confidence = 'high' | 'medium' | 'low';

// Pattern definition with confidence level
export interface PatternDef {
  pattern: RegExp;
  confidence: Confidence;
  description?: string; // Optional human-readable description
}

export interface TraitWarning {
  trait: TraitType;
  patterns: string[]; // What was detected
  suggestion: string; // How to mitigate
  confidence?: Confidence;
}

export interface TraitAnalysis {
  traits: TraitType[];
  warnings: TraitWarning[];
  severity: Severity;
  summary: string;
}

// ─── Severity Calculation ─────────────────────────────────────────────────────

function calculateSeverity(traits: TraitType[]): Severity {
  if (traits.includes('destructive') || traits.includes('infinite_loop')) {
    return 'caution';
  }
  if (traits.includes('slow') || traits.includes('n_plus_one') || traits.includes('rate_limit_risk')) {
    return 'warning';
  }
  if (traits.length > 0) {
    return 'info';
  }
  return 'info';
}

function generateSummary(warnings: TraitWarning[]): string {
  if (warnings.length === 0) return '';
  if (warnings.length === 1) return `1 trait detected: ${warnings[0].trait}`;
  return `${warnings.length} traits detected: ${warnings.map(w => w.trait).join(', ')}`;
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

const SUGGESTIONS: Record<TraitType, string> = {
  destructive: 'This operation may delete or modify data permanently',
  stateful: 'Creates persistent state (connections, timers) - clean up when done',
  external: 'Makes network request - may fail or be slow',
  slow: 'May take several seconds to complete',
  n_plus_one: 'Multiple sequential requests detected - consider batching',
  rate_limit_risk: 'Many rapid requests - may trigger rate limits',
  infinite_loop: 'Loop may not terminate - verify exit condition',
};

// ─── JS/TS Pattern Definitions ────────────────────────────────────────────────

export const DESTRUCTIVE_PATTERNS_JS: PatternDef[] = [
  // File system deletions - HIGH confidence
  { pattern: /\.(unlink|unlinkSync|rmdir|rmdirSync|rmSync)\s*\(/, confidence: 'high' },
  { pattern: /\brimraf\s*\(|deleteSync\s*\(/i, confidence: 'high' },

  // SQL destructive - MEDIUM confidence (could be in string)
  { pattern: /\.(execute|query)\s*\([^)]*DROP\s+(TABLE|DATABASE|INDEX)/i, confidence: 'medium' },
  { pattern: /\.(execute|query)\s*\([^)]*DELETE\s+FROM/i, confidence: 'medium' },
  { pattern: /\.(execute|query)\s*\([^)]*TRUNCATE\s+TABLE/i, confidence: 'medium' },

  // ORM destructive - HIGH confidence
  { pattern: /\.(destroy|remove)\s*\(\s*\{/, confidence: 'high' }, // Sequelize/Mongoose

  // NOTE: .delete() excluded - too many false positives (Map, Set, URLSearchParams)
];

export const STATEFUL_PATTERNS_JS: PatternDef[] = [
  { pattern: /\bpuppeteer\.launch\s*\(/i, confidence: 'high' },
  { pattern: /\bplaywright\.[^.]+\.launch\s*\(/i, confidence: 'high' },
  { pattern: /\bsetInterval\s*\(/, confidence: 'high' },
  { pattern: /\bsetTimeout\s*\(/, confidence: 'medium' },
  { pattern: /new\s+(Worker|SharedWorker|ServiceWorker)\s*\(/, confidence: 'high' },
  { pattern: /\bcreateConnection\s*\(/, confidence: 'high' },
  { pattern: /\bmongoose\.connect\s*\(/, confidence: 'high' },
  { pattern: /\bprisma\.\$connect\s*\(/, confidence: 'high' },
  { pattern: /new\s+Pool\s*\(/, confidence: 'high' }, // pg Pool
  { pattern: /\.connect\s*\(\s*\)/, confidence: 'medium' }, // Generic
  { pattern: /new\s+WebSocket\s*\(/, confidence: 'high' }, // WebSocket connection
  { pattern: /new\s+EventEmitter\s*\(/, confidence: 'medium' }, // EventEmitter
];

export const EXTERNAL_PATTERNS_JS: PatternDef[] = [
  // Actual function calls - HIGH confidence
  { pattern: /\bfetch\s*\(\s*['"`]/, confidence: 'high' },
  { pattern: /\bfetch\s*\(\s*\w/, confidence: 'medium' }, // fetch(url) variable
  { pattern: /\baxios\s*\.\s*(get|post|put|delete|patch)\s*\(/, confidence: 'high' },
  { pattern: /\bgot\s*\(|\bgot\s*\.\s*(get|post)\s*\(/, confidence: 'high' },
  { pattern: /\bnew\s+XMLHttpRequest\s*\(/, confidence: 'high' },
  { pattern: /require\s*\(\s*['"`]node-fetch['"`]\s*\)/, confidence: 'medium' },
  { pattern: /\bhttps?\.(get|post|put|delete|request)\s*\(/, confidence: 'high' }, // Node http/https module

  // NOTE: URL literals excluded - too many false positives (strings, comments)
];

export const SLOW_PATTERNS_JS: PatternDef[] = [
  // Async loops - HIGH/MEDIUM confidence
  { pattern: /\.forEach\s*\(\s*async\b[\s\S]{0,200}?await\b/, confidence: 'high' },
  { pattern: /for\s*\([^)]{0,100}\)\s*\{[\s\S]{0,500}?await\b/, confidence: 'medium' },
  { pattern: /while\s*\([^)]{0,100}\)\s*\{[\s\S]{0,500}?await\b/, confidence: 'medium' },

  // Known slow operations
  { pattern: /\b(puppeteer|playwright|chromium|firefox|webkit)\b/i, confidence: 'high' },
  { pattern: /\.screenshot\s*\(/, confidence: 'high' },
  { pattern: /\b(webpack|esbuild|rollup|vite)\s*\(/, confidence: 'medium' },
];

// ─── Shell Pattern Definitions ────────────────────────────────────────────────

export const DESTRUCTIVE_PATTERNS_SHELL: PatternDef[] = [
  { pattern: /\brm\s+-(r|rf|fr|f\s+-r)\b/, confidence: 'high' },
  { pattern: /\brm\s+[^|;\n]*\*/, confidence: 'high' }, // rm with wildcards
  { pattern: /\bgit\s+reset\s+--hard\b/, confidence: 'high' },
  { pattern: /\bgit\s+clean\s+-[fd]+\b/, confidence: 'high' },
  { pattern: /\bgit\s+push\s+.*--force\b/, confidence: 'high' },
  { pattern: /\bgit\s+push\s+(-f\b|.*\s+-f\b)/, confidence: 'high' }, // git push -f
  { pattern: /\bdd\s+if=/, confidence: 'high' }, // dd disk destroyer
  { pattern: /\bdocker\s+(rm|rmi)\s/, confidence: 'medium' },
  { pattern: /\bdocker\s+system\s+prune\b/, confidence: 'high' },
  { pattern: /\bdropdb\s+|\bDROP\s+DATABASE\b/i, confidence: 'high' },
  { pattern: /\btruncate\s+/i, confidence: 'medium' },
];

export const STATEFUL_PATTERNS_SHELL: PatternDef[] = [
  { pattern: /\bdocker\s+run\b(?!.*--rm)/, confidence: 'medium' },
  { pattern: /\bnohup\b/, confidence: 'high' }, // nohup backgrounding
  { pattern: /&\s*$/, confidence: 'high' }, // background process (&)
  { pattern: /\bpm2\s+(start|restart|reload)\b/, confidence: 'high' }, // pm2 process manager
];

export const EXTERNAL_PATTERNS_SHELL: PatternDef[] = [
  { pattern: /\bcurl\s+/, confidence: 'high' }, // curl (with or without flags)
  { pattern: /\bwget\s+/, confidence: 'high' },
  { pattern: /\bssh\s+\w/, confidence: 'high' },
  { pattern: /\bscp\s+/, confidence: 'high' },
  { pattern: /\b(aws|gcloud|az)\s+\w/, confidence: 'high' },
];

export const SLOW_PATTERNS_SHELL: PatternDef[] = [
  { pattern: /\b(npm|pnpm|yarn)\s+(install|ci|add)\b/, confidence: 'high' },
  { pattern: /\bbun\s+install\b/, confidence: 'high' },
  { pattern: /\bdocker\s+build\b/, confidence: 'high' },
  { pattern: /\bdocker\s+pull\b/, confidence: 'medium' },
  { pattern: /\bgit\s+clone\b/, confidence: 'high' }, // git clone
  { pattern: /\bfind\s+\//, confidence: 'medium' }, // Find from root
  { pattern: /\btar\s+[cxz]/, confidence: 'medium' },
  { pattern: /\brsync\b/, confidence: 'medium' },
];
// ─── Python Pattern Definitions ───────────────────────────────────────────────

export const DESTRUCTIVE_PATTERNS_PYTHON: PatternDef[] = [
  { pattern: /os\.remove|os\.unlink|shutil\.rmtree/, confidence: 'high' },
  { pattern: /\.execute\([^)]*DELETE/i, confidence: 'medium' },
  { pattern: /cursor\.execute\([^)]*DROP/i, confidence: 'medium' },
];

export const STATEFUL_PATTERNS_PYTHON: PatternDef[] = [
  { pattern: /\bselenium\b|\bplaywright\b/i, confidence: 'high' },
  { pattern: /\bpsycopg2\.connect\s*\(|\bmysql\.connector\.connect\s*\(/, confidence: 'high' },
  { pattern: /\bthreading\.Thread\s*\(/, confidence: 'high' },
  { pattern: /\basyncio\.create_task\s*\(/, confidence: 'medium' },
];

export const EXTERNAL_PATTERNS_PYTHON: PatternDef[] = [
  { pattern: /requests\.(get|post|put|delete)/, confidence: 'high' },
  { pattern: /urllib\.request|httpx|aiohttp/, confidence: 'high' },
  { pattern: /boto3\.|google\.cloud|azure\./, confidence: 'high' },
];

export const SLOW_PATTERNS_PYTHON: PatternDef[] = [
  { pattern: /\bsubprocess\.(run|call|Popen)\s*\(/, confidence: 'medium' },
  { pattern: /\btime\.sleep\s*\(/, confidence: 'medium' },
  { pattern: /\bselenium\b|\bplaywright\b/i, confidence: 'high' },
];

// ─── Cache ────────────────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 100;
const traitCache = new Map<string, TraitAnalysis>();

function getCacheKey(language: string, code: string): string {
  return `${language}:${code.length}:${code.slice(0, 100)}`;
}

export function clearTraitCache(): void {
  traitCache.clear();
}

// ─── Preprocessing ────────────────────────────────────────────────────────────

/**
 * Strip comments from code before pattern matching.
 * Prevents false positives from commented-out code.
 */
export function preprocess(code: string, language: string): string {
  if (language === 'shell') {
    // Strip # comments (simple heuristic, ignores strings)
    return code.replace(/#[^\n]*/g, '');
  }

  if (language === 'python') {
    // Strip triple-quoted strings then # comments
    return code
      .replace(/'''[\s\S]*?'''/g, "''")
      .replace(/"""[\s\S]*?"""/g, '""')
      .replace(/#[^\n]*/g, '');
  }

  // JavaScript / TypeScript
  // @mcx-ignore: strip preceding directive line AND same-line inline directive
  return code
    .replace(/\/\/\s*@mcx-ignore[^\n]*\n[^\n]*/g, '') // @mcx-ignore on own line → skip that line + next line
    .replace(/[^\n]*\/\/\s*@mcx-ignore[^\n]*/g, '') // inline @mcx-ignore → skip that line
    .replace(/\/\*[\s\S]*?\*\//g, '') // Block comments
    .replace(/\/\/[^\n]*/g, ''); // Line comments
}

// ─── Pattern Matching Helpers ─────────────────────────────────────────────────

function matchPatterns(
  code: string,
  patternDefs: PatternDef[],
  trait: TraitType,
): TraitWarning | null {
  const matched: string[] = [];
  let worstConfidence: Confidence = 'high';

  for (const { pattern, confidence, description } of patternDefs) {
    const match = code.match(pattern);
    if (match) {
      matched.push(description ?? match[0].trim().slice(0, 60));
      // Track the least confident match
      if (confidence === 'low' || (confidence === 'medium' && worstConfidence === 'high')) {
        worstConfidence = confidence;
      }
    }
  }

  if (matched.length === 0) return null;

  return {
    trait,
    patterns: [...new Set(matched)], // Deduplicate
    suggestion: SUGGESTIONS[trait],
    confidence: worstConfidence,
  };
}

// ─── Analysis Functions ───────────────────────────────────────────────────────

/**
 * Analyze JS/TS/Python code for traits.
 */
export function analyzeCodeTraits(
  code: string,
  language: 'javascript' | 'typescript' | 'python',
): TraitAnalysis {
  const cacheKey = getCacheKey(language, code);
  const cached = traitCache.get(cacheKey);
  if (cached) return cached;

  const clean = preprocess(code, language === 'python' ? 'python' : 'javascript');

  let destructivePatterns: PatternDef[];
  let statefulPatterns: PatternDef[];
  let externalPatterns: PatternDef[];
  let slowPatterns: PatternDef[];

  if (language === 'python') {
    destructivePatterns = DESTRUCTIVE_PATTERNS_PYTHON;
    statefulPatterns = STATEFUL_PATTERNS_PYTHON;
    externalPatterns = EXTERNAL_PATTERNS_PYTHON;
    slowPatterns = SLOW_PATTERNS_PYTHON;
  } else {
    destructivePatterns = DESTRUCTIVE_PATTERNS_JS;
    statefulPatterns = STATEFUL_PATTERNS_JS;
    externalPatterns = EXTERNAL_PATTERNS_JS;
    slowPatterns = SLOW_PATTERNS_JS;
  }

  const warnings: TraitWarning[] = [];

  const destructive = matchPatterns(clean, destructivePatterns, 'destructive');
  if (destructive) warnings.push(destructive);

  const stateful = matchPatterns(clean, statefulPatterns, 'stateful');
  if (stateful) warnings.push(stateful);

  const external = matchPatterns(clean, externalPatterns, 'external');
  if (external) warnings.push(external);

  const slow = matchPatterns(clean, slowPatterns, 'slow');
  if (slow) warnings.push(slow);

  const traits = warnings.map((w) => w.trait);
  const analysis: TraitAnalysis = {
    traits,
    warnings,
    severity: calculateSeverity(traits),
    summary: generateSummary(warnings),
  };

  // Evict oldest entry if cache is full
  if (traitCache.size >= MAX_CACHE_SIZE) {
    const firstKey = traitCache.keys().next().value;
    if (firstKey !== undefined) traitCache.delete(firstKey);
  }
  traitCache.set(cacheKey, analysis);

  return analysis;
}

/**
 * Analyze shell commands for traits.
 */
export function analyzeShellTraits(command: string): TraitAnalysis {
  const cacheKey = getCacheKey('shell', command);
  const cached = traitCache.get(cacheKey);
  if (cached) return cached;

  const clean = preprocess(command, 'shell');

  const warnings: TraitWarning[] = [];

  const destructive = matchPatterns(clean, DESTRUCTIVE_PATTERNS_SHELL, 'destructive');
  if (destructive) warnings.push(destructive);

  const stateful = matchPatterns(clean, STATEFUL_PATTERNS_SHELL, 'stateful');
  if (stateful) warnings.push(stateful);

  const external = matchPatterns(clean, EXTERNAL_PATTERNS_SHELL, 'external');
  if (external) warnings.push(external);

  const slow = matchPatterns(clean, SLOW_PATTERNS_SHELL, 'slow');
  if (slow) warnings.push(slow);

  const traits = warnings.map((w) => w.trait);
  const analysis: TraitAnalysis = {
    traits,
    warnings,
    severity: calculateSeverity(traits),
    summary: generateSummary(warnings),
  };

  // Evict oldest entry if cache is full
  if (traitCache.size >= MAX_CACHE_SIZE) {
    const firstKey = traitCache.keys().next().value;
    if (firstKey !== undefined) traitCache.delete(firstKey);
  }
  traitCache.set(cacheKey, analysis);

  return analysis;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const CONFIDENCE_ICON: Record<Confidence, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🔵',
};

const TRAIT_ICON: Record<TraitType, string> = {
  destructive: '⚠️',
  stateful: '🔗',
  external: '🌐',
  slow: '⏱️',
  n_plus_one: '🔄',
  rate_limit_risk: '🚦',
  infinite_loop: '♾️',
};

/**
 * Format trait warnings into a human-readable string for display.
 */
export function formatTraitWarnings(analysis: TraitAnalysis): string {
  if (analysis.warnings.length === 0) return '';

  const severityIcon: Record<string, string> = {
    caution: '🔴',
    warning: '⚠️',
    info: '💡',
  };
  const headerIcon = severityIcon[analysis.severity];
  const lines: string[] = [`${headerIcon} Trait Analysis:`];

  for (const warning of analysis.warnings) {
    const icon = TRAIT_ICON[warning.trait] ?? '⚠️';
    const confidenceIcon = warning.confidence ? CONFIDENCE_ICON[warning.confidence] : '';
    lines.push(`  ${icon} ${warning.trait} ${confidenceIcon}`.trimEnd());

    for (const p of warning.patterns.slice(0, 3)) {
      lines.push(`    • ${p}`);
    }

    lines.push(`    → ${warning.suggestion}`);
  }

  return lines.join('\n');
}
