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

interface ScanState {
  i: number;
  line: number;
  inString: boolean;
  stringChar: string;
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
    inString: false,
    stringChar: "",
    inLineComment: false,
    inBlockComment: false,
    inRegex: false,
    escaped: false,
    templateDepth: 0,
  };
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
  }
  return true;
}

function detectComment(content: string, state: ScanState): boolean {
  if (state.inString) return false;
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
  if (state.inString) return false;
  const char = content[state.i];
  const next = content[state.i + 1];
  if (char !== "/" || next === "=" || next === undefined) return false;
  
  const prev = state.i > 0 ? content[state.i - 1] : "";
  if (/[a-zA-Z0-9_$)\]]/.test(prev)) return false;
  
  state.inRegex = true;
  return true;
}

function handleTemplateInterpolation(content: string, state: ScanState): boolean {
  if (!state.inString || state.stringChar !== "`") return false;
  if (state.escaped) return false;
  if (content[state.i] !== "$" || content[state.i + 1] !== "{") return false;
  
  state.templateDepth++;
  state.i++;
  return true;
}

function handleStringChar(content: string, state: ScanState): void {
  const char = content[state.i];
  if (char !== '"' && char !== "'" && char !== "`") return;
  
  if (!state.inString) {
    state.inString = true;
    state.stringChar = char;
  } else if (char === state.stringChar && !state.escaped && state.templateDepth === 0) {
    state.inString = false;
  }
}

function handleStringContent(content: string, state: ScanState): boolean {
  if (!state.inString) return false;
  // Inside template interpolation ${...}, braces are code - don't skip
  if (state.templateDepth > 0) return false;
  const char = content[state.i];
  if (state.escaped) state.escaped = false;
  else if (char === "\\") state.escaped = true;
  return true;
}

// ============================================================================
// Main Function
// ============================================================================

export function checkBraceBalance(content: string): BraceResult {
  const state = createState();
  const openStack: number[] = [];
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
    const countBraces = !state.inString || state.templateDepth > 0;
    if (countBraces && char === "{") openStack.push(state.line);
    if (char === "}") {
      if (state.templateDepth > 0) {
        state.templateDepth--;
      } else if (countBraces) {
        if (openStack.length > 0) openStack.pop();
        else unmatchedLines.push(state.line);
      }
    }

    state.i++;
  }

  return {
    balance: openStack.length - unmatchedLines.length,
    unclosedLines: openStack,
    unmatchedLines,
  };
}
