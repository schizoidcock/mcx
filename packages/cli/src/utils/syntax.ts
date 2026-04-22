/**
 * Syntax Analysis Utilities
 * 
 * Code parsing helpers following Linus principles:
 * - Functions 10-15 lines max
 * - Max 5-10 local variables
 * - Max 3 indentation levels
 */

// ============================================================================
// Types
// ============================================================================

export interface BraceResult {
  balance: number;
  unclosedLines: number[];
  unmatchedLines: number[];
}

interface StringFrame {
  char: string;
  depth: number;
}

interface ScanState {
  i: number;
  line: number;
  stringStack: StringFrame[];
  inLineComment: boolean;
  inBlockComment: boolean;
  inRegex: boolean;
  escaped: boolean;
  templateDepth: number;
}

// ============================================================================
// State Factory
// ============================================================================

function createState(): ScanState {
  return {
    i: 0,
    line: 1,
    stringStack: [],
    inLineComment: false,
    inBlockComment: false,
    inRegex: false,
    escaped: false,
    templateDepth: 0,
  };
}

function inString(state: ScanState): boolean {
  return state.stringStack.length > 0;
}

function currentStringChar(state: ScanState): string {
  const top = state.stringStack[state.stringStack.length - 1];
  return top?.char || "";
}

// ============================================================================
// Skip Helpers (mutate state, return true if skipped)
// ============================================================================

function handleNewline(char: string, state: ScanState): boolean {
  if (char !== "\n") return false;
  state.line++;
  state.inLineComment = false;
  return false;
}

function handleLineComment(char: string, state: ScanState): boolean {
  if (!state.inLineComment) return false;
  return char !== "\n";
}

function handleBlockComment(content: string, state: ScanState): boolean {
  if (!state.inBlockComment) return false;
  if (content[state.i] === "*" && content[state.i + 1] === "/") {
    state.inBlockComment = false;
    state.i++;
  }
  return true;
}

function handleRegex(content: string, state: ScanState): boolean {
  if (!state.inRegex) return false;
  const char = content[state.i];
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (char === "\\") {
    state.escaped = true;
    return true;
  }
  if (char === "/") {
    state.inRegex = false;
    // Skip regex flags
    while (/[gimsuy]/.test(content[state.i + 1])) state.i++;
  }
  return true;
}

function detectComment(content: string, state: ScanState): boolean {
  if (inString(state)) return false;
  const char = content[state.i];
  const next = content[state.i + 1];
  if (char === "/" && next === "/") {
    state.inLineComment = true;
    return true;
  }
  if (char === "/" && next === "*") {
    state.inBlockComment = true;
    return true;
  }
  return false;
}

function detectRegex(content: string, state: ScanState): boolean {
  if (inString(state)) return false;
  const char = content[state.i];
  const next = content[state.i + 1];
  if (char !== "/" || next === "=" || next === undefined) return false;
  
  const prev = state.i > 0 ? content[state.i - 1] : "";
  if (/[a-zA-Z0-9_$)\]]/.test(prev)) return false;
  
  state.inRegex = true;
  return true;
}

function handleTemplateInterpolation(content: string, state: ScanState): boolean {
  if (!inString(state) || currentStringChar(state) !== "`") return false;
  if (state.escaped) return false;
  if (content[state.i] !== "$" || content[state.i + 1] !== "{") return false;
  
  state.templateDepth++;
  state.i++;
  return true;
}

function handleStringChar(content: string, state: ScanState): void {
  const char = content[state.i];
  if (char !== '"' && char !== "'" && char !== "`") return;
  
  const top = state.stringStack[state.stringStack.length - 1];
  
  if (!top) {
    // Not in string - open new one
    state.stringStack.push({ char, depth: state.templateDepth });
  } else if (char === top.char && !state.escaped && top.depth === state.templateDepth) {
    // Same char, same depth - close string
    state.stringStack.pop();
  } else if (state.templateDepth > top.depth) {
    // Inside interpolation - can open nested string
    state.stringStack.push({ char, depth: state.templateDepth });
  }
}

function handleStringContent(content: string, state: ScanState): boolean {
  if (!inString(state)) return false;
  // Inside template interpolation ${...}, braces are code - don't skip
  if (state.templateDepth > 0) return false;
  const char = content[state.i];
  if (state.escaped) state.escaped = false;
  else if (char === "\\") state.escaped = true;
  return true;
}

// ============================================================================
// Helper: find last matching element
// ============================================================================

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

// ============================================================================
// Main Function
// ============================================================================

/** Handle closing brace - match or track unmatched */
function handleCloseBrace(
  openStack: Array<{line: number; depth: number}>,
  unmatchedLines: number[],
  state: ScanState,
  countBraces: boolean
): void {
  const matchIdx = findLastIndex(openStack, b => b.depth === state.templateDepth);
  if (matchIdx >= 0) return void openStack.splice(matchIdx, 1);
  if (state.templateDepth > 0) return void state.templateDepth--;
  if (countBraces) unmatchedLines.push(state.line);
}

export function checkBraceBalance(content: string): BraceResult {
  const state = createState();
  // Track {line, depth} to distinguish object braces from interpolation close
  const openStack: Array<{line: number; depth: number}> = [];
  const unmatchedLines: number[] = [];

  while (state.i < content.length) {
    const char = content[state.i];

    // Skip non-code sections
    if (handleNewline(char, state)) { state.i++; continue; }
    if (handleLineComment(char, state)) { state.i++; continue; }
    if (handleBlockComment(content, state)) { state.i++; continue; }
    if (handleRegex(content, state)) { state.i++; continue; }
    if (detectComment(content, state)) { state.i++; continue; }
    if (detectRegex(content, state)) { state.i++; continue; }
    if (handleTemplateInterpolation(content, state)) { state.i++; continue; }

    // Handle strings
    handleStringChar(content, state);
    if (handleStringContent(content, state)) { state.i++; continue; }

    // Count braces (only when not in string, or inside template interpolation)
    const countBraces = !inString(state) || state.templateDepth > 0;
    if (countBraces && char === "{") {
      openStack.push({line: state.line, depth: state.templateDepth});
    }
    if (char === "}") {
      handleCloseBrace(openStack, unmatchedLines, state, countBraces);
    }

    state.i++;
  }

  return {
    balance: openStack.length - unmatchedLines.length,
    unclosedLines: openStack.map(b => b.line),
    unmatchedLines,
  };
}
