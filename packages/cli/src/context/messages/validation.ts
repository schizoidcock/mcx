/**
 * Validation Messages - Parameter validation errors
 * ONE source of truth for validation error messages
 */

export const validationErrors = {
  missing: (param: string) =>
    `Missing ${param} parameter`,

  missingWithExample: (param: string, example: string) =>
    `Missing ${param} parameter\n${example}`,

  required: (param: string, instead: string) =>
    `${param} requires ${instead}`,

  incompatible: (param1: string, param2: string) =>
    `Cannot use ${param1} and ${param2} together`,

  absolutePath: (got: string) =>
    `Absolute path required. Got: "${got}"`,

  mustBeType: (param: string, expectedType: string) =>
    `${param} must be ${expectedType}`,

  invalidFormat: (param: string, got: string, expected: string) =>
    `Invalid ${param}: "${got}". ${expected}`,

  notFound: (type: string, name: string) =>
    `${type} not found: ${name}`,

  notFoundWithAvailable: (type: string, name: string, available: string[]) =>
    `${type} "${name}" not found. Available: ${available.join(", ")}`,

  methodNotFound: (method: string, adapter: string, available: string[]) =>
    `Method "${method}" not found in ${adapter}. Available: ${available.join(", ")}`,

  noAdaptersLoaded: () =>
    "No adapters loaded",

  empty: (param: string) =>
    `Empty ${param}`,

  requireOneOf: (options: string[]) =>
    `Specify one of: ${options.join(", ")}`,

  onlyOneOf: (options: string[]) =>
    `Specify only one of: ${options.join(", ")}`,

  unbalancedBraces: (count: number, type: string, lines: number[]) =>
    `unbalanced braces - ${count} ${type} brace(s) at line(s): ${lines.join(', ')}`,

  suspiciousDuplicates: (duplicates: string[]) =>
    `Suspicious duplicates:\n${duplicates.join('\n')}`,

  alreadyRunning: (type: string, id: string) =>
    `${type} "${id}" already running`,

  fileTooLarge: (threshold: string) =>
    `File too large for code execution (>${threshold} chars). Use intent to search, or mcx_search() after indexing.`,
};
