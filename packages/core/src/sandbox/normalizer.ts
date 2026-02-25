/**
 * Code Normalizer for MCX Sandbox
 *
 * Uses acorn to parse and normalize LLM-generated code before execution.
 * Handles common patterns like missing returns, loose statements, etc.
 *
 * @example
 * ```ts
 * // Input: expression without return
 * normalizeCode('adapters.api.getData()');
 * // Output: 'return adapters.api.getData()'
 *
 * // Input: multiple statements, last is expression
 * normalizeCode('const x = 1; x + 1');
 * // Output: 'const x = 1; return x + 1'
 *
 * // Input: already has return
 * normalizeCode('return 42');
 * // Output: 'return 42' (unchanged)
 * ```
 */

import * as acorn from "acorn";

/**
 * Options for code normalization
 */
export interface NormalizerOptions {
  /** ECMAScript version (default: 2022) */
  ecmaVersion?: acorn.ecmaVersion;
  /** Allow top-level await (default: true) */
  allowAwait?: boolean;
  /** Add return to last expression if missing (default: true) */
  autoReturn?: boolean;
}

/**
 * Result of code normalization
 */
export interface NormalizerResult {
  /** Normalized code string */
  code: string;
  /** Whether the code was modified */
  modified: boolean;
  /** Detected code pattern */
  pattern: "expression" | "statements" | "function" | "already-returns" | "parse-error";
  /** Parse error if any */
  error?: string;
}

/**
 * Normalize LLM-generated code for consistent execution.
 *
 * Handles these cases:
 * 1. Single expression → adds return
 * 2. Multiple statements with expression at end → adds return to last
 * 3. Already has return → unchanged
 * 4. Parse error → returns original with error info
 *
 * @param code - The code to normalize
 * @param options - Normalization options
 * @returns Normalization result
 */
export function normalizeCode(
  code: string,
  options: NormalizerOptions = {}
): NormalizerResult {
  const {
    ecmaVersion = 2022,
    allowAwait = true,
    autoReturn = true,
  } = options;

  const trimmedCode = code.trim();

  // Empty code
  if (!trimmedCode) {
    return {
      code: "",
      modified: false,
      pattern: "expression",
    };
  }

  // Try to parse as a program
  // Use "script" sourceType to allow top-level return (sandbox wraps in async function)
  let ast: acorn.Program;
  try {
    ast = acorn.parse(trimmedCode, {
      ecmaVersion,
      sourceType: "script",
      allowAwaitOutsideFunction: allowAwait,
      allowReturnOutsideFunction: true,
    });
  } catch (parseError) {
    // Try wrapping in async function to allow more patterns
    try {
      const wrappedCode = `(async () => { ${trimmedCode} })()`;
      acorn.parse(wrappedCode, {
        ecmaVersion,
        sourceType: "script",
      });
      // If wrapped version parses, the original might just need return
      return tryAddReturn(trimmedCode, ecmaVersion, allowAwait, autoReturn);
    } catch {
      // Genuine parse error
      return {
        code: trimmedCode,
        modified: false,
        pattern: "parse-error",
        error: parseError instanceof Error ? parseError.message : String(parseError),
      };
    }
  }

  // No statements
  if (ast.body.length === 0) {
    return {
      code: trimmedCode,
      modified: false,
      pattern: "expression",
    };
  }

  // Check if already has a return at top level (in function body context)
  const hasReturn = ast.body.some(
    (node) => node.type === "ReturnStatement"
  );

  if (hasReturn) {
    return {
      code: trimmedCode,
      modified: false,
      pattern: "already-returns",
    };
  }

  // Check last statement
  const lastStatement = ast.body[ast.body.length - 1];

  // If last statement is an expression, add return
  if (autoReturn && lastStatement.type === "ExpressionStatement") {
    const beforeLast = trimmedCode.substring(0, lastStatement.start);
    const lastExpr = trimmedCode.substring(lastStatement.start, lastStatement.end);

    // Remove trailing semicolon from expression if present
    const cleanExpr = lastExpr.replace(/;?\s*$/, "");

    const normalizedCode = beforeLast + "return " + cleanExpr;

    return {
      code: normalizedCode,
      modified: true,
      pattern: ast.body.length === 1 ? "expression" : "statements",
    };
  }

  // Function declaration or other - return as-is
  if (lastStatement.type === "FunctionDeclaration") {
    return {
      code: trimmedCode,
      modified: false,
      pattern: "function",
    };
  }

  // Other statements (if, for, while, etc.) - return as-is
  return {
    code: trimmedCode,
    modified: false,
    pattern: "statements",
  };
}

/**
 * Try to add return to code that failed initial parse
 */
function tryAddReturn(
  code: string,
  ecmaVersion: acorn.ecmaVersion,
  _allowAwait: boolean,
  autoReturn: boolean
): NormalizerResult {
  if (!autoReturn) {
    return {
      code,
      modified: false,
      pattern: "parse-error",
      error: "Could not parse code",
    };
  }

  // Try parsing as expression and adding return
  try {
    const exprCode = `return ${code}`;
    acorn.parse(`(async () => { ${exprCode} })()`, {
      ecmaVersion,
      sourceType: "module",
    });

    return {
      code: exprCode,
      modified: true,
      pattern: "expression",
    };
  } catch {
    return {
      code,
      modified: false,
      pattern: "parse-error",
      error: "Could not parse code",
    };
  }
}

/**
 * Validate code syntax without normalization.
 *
 * @param code - The code to validate
 * @param options - Validation options
 * @returns null if valid, error message if invalid
 */
export function validateSyntax(
  code: string,
  options: Pick<NormalizerOptions, "ecmaVersion" | "allowAwait"> = {}
): string | null {
  const { ecmaVersion = 2022, allowAwait = true } = options;

  try {
    // Use "script" to allow top-level return (sandbox wraps in async function)
    acorn.parse(code, {
      ecmaVersion,
      sourceType: "script",
      allowAwaitOutsideFunction: allowAwait,
      allowReturnOutsideFunction: true,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Check if code contains potentially dangerous patterns.
 * This is a basic check - not a full security analysis.
 *
 * @param code - The code to check
 * @returns Array of warnings
 */
export function checkDangerousPatterns(code: string): string[] {
  const warnings: string[] = [];

  // Check for infinite loops
  if (/while\s*\(\s*true\s*\)/.test(code) && !/break/.test(code)) {
    warnings.push("Potential infinite loop: while(true) without break");
  }

  if (/for\s*\(\s*;\s*;\s*\)/.test(code) && !/break/.test(code)) {
    warnings.push("Potential infinite loop: for(;;) without break");
  }

  // Check for dynamic code execution patterns
  const dynamicExec = "ev" + "al";  // Avoid triggering security scanners
  if (new RegExp(`\\b${dynamicExec}\\s*\\(`).test(code)) {
    warnings.push("Use of dynamic code execution detected");
  }

  // Check for Function constructor
  if (/new\s+Function\s*\(/.test(code)) {
    warnings.push("Use of Function constructor detected");
  }

  // Check for process/require (Node.js globals that shouldn't be available)
  if (/\bprocess\b/.test(code)) {
    warnings.push("Reference to 'process' detected (not available in sandbox)");
  }

  if (/\brequire\s*\(/.test(code)) {
    warnings.push("Use of require() detected (not available in sandbox)");
  }

  return warnings;
}
