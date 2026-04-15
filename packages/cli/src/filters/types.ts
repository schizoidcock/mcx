/**
 * Filter Types
 * 
 * Interfaces for declarative output filtering system.
 */

// ============================================================================
// Types
// ============================================================================

/** Pre-compiled regexes for a filter rule */
export interface CompiledPatterns {
  matchCommand: RegExp;
  matchOutput?: RegExp;
  replace?: [RegExp, string][];
  stripLines?: RegExp[];
  keepLines?: RegExp[];
}

/** Declarative filter rule (can be loaded from ~/.mcx/filters/*.json) */
export interface FilterRule {
  name: string;
  description?: string;
  matchCommand: string;       // Regex to match command
  matchOutput?: string;       // Optional: only apply if output matches
  pipeline: {
    stripAnsi?: boolean;
    stripLines?: string[];    // Regex patterns for lines to remove
    keepLines?: string[];     // If set, only keep matching lines
    replace?: [string, string][];  // [pattern, replacement] pairs
    maxLines?: number;
    onEmpty?: string;         // Message when output becomes empty
    truncateAt?: number;      // Max chars before truncation
  };
  _compiled?: CompiledPatterns;
}
