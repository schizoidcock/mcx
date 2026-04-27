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
  if (content[state.i] === "*" && content[state.i + 1] === "/") {
    state.inBlockComment = false;
    state.i++;
  }
  return true;
}

function handleRegex(content: string, state: ScanState, regexWithNewline: number[]): boolean {
  if (!state.inRegex) return false;
  // Detect literal newline in regex
  if (content[state.i] === '\n') {
    if (!regexWithNewline.includes(state.line)) regexWithNewline.push(state.line);
  }
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
  
  return true;
}

function handleTemplateInterpolation(content: string, state: ScanState): boolean {
  if (!inString(state) || currentStringChar(state) !== "`") return false;
  if (state.escaped) return false;
  if (content[state.i] !== "$" || content[state.i + 1] !== "{") return false;
  
  state.templateDepth++;
  return true;  // Caller handles i increment
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
  if (!countBraces) return;
  const matchIdx = findLastIndex(openStack, b => b.depth === state.templateDepth);
  if (matchIdx >= 0) return void openStack.splice(matchIdx, 1);
  if (state.templateDepth > 0) return void state.templateDepth--;
  if (countBraces) unmatchedLines.push(state.line);
}


// ============================================================================
// Unified Scanner Result
// ============================================================================

export interface ScanResult {
  regexWithNewline: number[]; // Lines with regex containing literal newline
  fixed: string;
  braceBalance: number;
  unclosedLines: number[];
  unmatchedLines: number[];
}

// ============================================================================
// Unified Scanner (ONE pass - Linus principle)
// ============================================================================

export function scanAndValidate(content: string): ScanResult {
  const state = createState();
  const NL = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  const BT = String.fromCharCode(96);
  
  const resultLines: string[] = [];
  let currentLine = "";
  const openStack: Array<{line: number; depth: number}> = [];
  const unmatchedLines: number[] = [];
  const regexWithNewline: number[] = [];

  while (state.i < content.length) {
    const char = content[state.i];
    const prevI = state.i;

    if (char === NL) {
      const esc = inString(state) && currentStringChar(state) !== BT &&
                  !state.inLineComment && !state.inBlockComment && !state.inRegex;
      if (esc) { currentLine += BS + "n"; }
      else { resultLines.push(currentLine); currentLine = ""; state.inLineComment = false; }
      state.line++;
      state.i++;
      continue;
    }

    if (handleLineComment(char, state)) { currentLine += char; state.i++; continue; }
    if (handleBlockComment(content, state)) { currentLine += content.slice(prevI, state.i + 1); state.i++; continue; }
    if (detectComment(content, state)) { currentLine += char; state.i++; continue; }
    if (detectRegex(content, state)) { currentLine += char; state.i++; continue; }
    if (handleTemplateInterpolation(content, state)) { currentLine += "${"; state.i += 2; continue; }

    handleStringChar(content, state);
    if (handleStringContent(content, state)) { currentLine += char; state.i++; continue; }

    const countBraces = !inString(state) || state.templateDepth > 0;
    if (char === "}") handleCloseBrace(openStack, unmatchedLines, state, countBraces);

    currentLine += char;
    state.i++;
  }

  if (currentLine) resultLines.push(currentLine);

  return {
    regexWithNewline,
    fixed: resultLines.join(NL),
    braceBalance: openStack.length - unmatchedLines.length,
    unclosedLines: openStack.map(b => b.line),
    unmatchedLines,
  };
}

// ============================================================================
// Public API (backward compatible)
// ============================================================================

export function checkBraceBalance(content: string): BraceResult {
  const r = scanAndValidate(content);
  return { balance: r.braceBalance, unclosedLines: r.unclosedLines, unmatchedLines: r.unmatchedLines };
}

export function fixBrokenStrings(content: string): string {
  return scanAndValidate(content).fixed;
}