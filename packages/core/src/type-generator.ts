/**
 * Type Generator for MCX Adapters
 *
 * Generates TypeScript type declarations from adapter definitions.
 * Used to provide LLM context with minimal tokens (Cloudflare pattern).
 *
 * @example
 * ```ts
 * const types = generateTypes(adapters, { includeDescriptions: true });
 * // Output:
 * // declare const myAdapter: {
 * //   getData(params: { id: string }): Promise<unknown>;
 * // }
 * ```
 */

import type { Adapter, ParameterDefinition } from "./types.js";

/**
 * Options for type generation
 */
export interface TypeGeneratorOptions {
  /** Include JSDoc descriptions in output (default: true) */
  includeDescriptions?: boolean;
  /** Use async return types (default: true) */
  asyncResults?: boolean;
  /** Namespace prefix for declarations (default: none) */
  namespace?: string;
}

/**
 * Generate TypeScript type declarations from adapters.
 *
 * @param adapters - Array of adapters to generate types for
 * @param options - Generation options
 * @returns TypeScript declaration string
 */
export function generateTypes(
  adapters: Adapter[],
  options: TypeGeneratorOptions = {}
): string {
  const { includeDescriptions = true, asyncResults = true } = options;
  const lines: string[] = [];

  for (const adapter of adapters) {
    const safeName = sanitizeIdentifier(adapter.name);

    // Generate input interface for each tool with parameters
    for (const [toolName, tool] of Object.entries(adapter.tools)) {
      if (tool.parameters && Object.keys(tool.parameters).length > 0) {
        const safeToolNameForType = sanitizeIdentifier(toolName);
        const inputTypeName = `${capitalize(safeName)}_${capitalize(safeToolNameForType)}_Input`;
        lines.push(generateInputInterface(inputTypeName, tool.parameters, includeDescriptions));
        lines.push("");
      }
    }

    // Generate adapter declaration
    if (includeDescriptions && adapter.description) {
      lines.push(`/** ${sanitizeJSDoc(adapter.description)} */`);
    }
    lines.push(`declare const ${safeName}: {`);

    for (const [toolName, tool] of Object.entries(adapter.tools)) {
      const safeToolName = sanitizeIdentifier(toolName);
      const hasParams = tool.parameters && Object.keys(tool.parameters).length > 0;
      // Use sanitized tool name in type name to ensure consistency
      const inputTypeName = `${capitalize(safeName)}_${capitalize(safeToolName)}_Input`;

      if (includeDescriptions && tool.description) {
        lines.push(`  /** ${sanitizeJSDoc(tool.description)} */`);
      }

      const paramStr = hasParams ? `params: ${inputTypeName}` : "";
      const returnType = asyncResults ? "Promise<unknown>" : "unknown";
      lines.push(`  ${safeToolName}(${paramStr}): ${returnType};`);
    }

    lines.push("};");
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Generate a compact type summary for token-constrained contexts.
 * Only shows adapter names and method count to minimize context usage.
 * Use mcx_search to discover specific methods.
 *
 * @param adapters - Array of adapters
 * @returns Compact summary string
 */
export function generateTypesSummary(adapters: Adapter[]): string {
  return adapters
    .map((adapter) => {
      const count = Object.keys(adapter.tools).length;
      return `- ${adapter.name} (${count} methods)`;
    })
    .join("\n");
}

/**
 * Generate input interface for a tool's parameters
 */
function generateInputInterface(
  typeName: string,
  parameters: Record<string, ParameterDefinition>,
  includeDescriptions: boolean
): string {
  const lines: string[] = [`interface ${typeName} {`];

  for (const [paramName, param] of Object.entries(parameters)) {
    // Sanitize parameter name to prevent injection
    const safeParamName = sanitizeIdentifier(paramName);

    if (includeDescriptions && param.description) {
      lines.push(`  /** ${sanitizeJSDoc(param.description)} */`);
    }

    const tsType = paramTypeToTS(param.type);
    const optional = param.required === false ? "?" : "";
    lines.push(`  ${safeParamName}${optional}: ${tsType};`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Convert parameter type to TypeScript type
 */
function paramTypeToTS(type: string): string {
  const typeMap: Record<string, string> = {
    string: "string",
    number: "number",
    boolean: "boolean",
    object: "Record<string, unknown>",
    array: "unknown[]",
  };
  return typeMap[type] || "unknown";
}

/**
 * Sanitize a string to be a valid JavaScript identifier
 */
export function sanitizeIdentifier(name: string): string {
  // Replace invalid characters with underscores
  let safe = name.replace(/[^a-zA-Z0-9_$]/g, "_");

  // Prefix with underscore if starts with number
  if (/^[0-9]/.test(safe)) {
    safe = "_" + safe;
  }

  // Handle reserved words
  const reserved = [
    "break", "case", "catch", "continue", "debugger", "default", "delete",
    "do", "else", "finally", "for", "function", "if", "in", "instanceof",
    "new", "return", "switch", "this", "throw", "try", "typeof", "var",
    "void", "while", "with", "class", "const", "enum", "export", "extends",
    "import", "super", "implements", "interface", "let", "package", "private",
    "protected", "public", "static", "yield",
  ];

  if (reserved.includes(safe)) {
    safe = safe + "_";
  }

  return safe;
}

/**
 * Capitalize first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Sanitize text for use in JSDoc comments.
 * Prevents comment injection via `*​/` sequences.
 */
function sanitizeJSDoc(text: string): string {
  return text.replace(/\*\//g, "* /").replace(/[\r\n]+/g, " ");
}
