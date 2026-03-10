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
 * Groups adapters by domain and shows method count.
 * Use mcx_search to discover specific methods.
 *
 * @param adapters - Array of adapters
 * @returns Compact summary string with domain hints
 */
export function generateTypesSummary(adapters: Adapter[]): string {
  // Group adapters by domain
  const byDomain = new Map<string, Adapter[]>();

  for (const adapter of adapters) {
    const domain = inferDomain(adapter);
    if (!byDomain.has(domain)) {
      byDomain.set(domain, []);
    }
    byDomain.get(domain)!.push(adapter);
  }

  // If only one domain or fewer than 4 adapters, simple list
  if (byDomain.size <= 1 || adapters.length < 4) {
    return adapters
      .map((adapter) => {
        const count = Object.keys(adapter.tools).length;
        return `- ${adapter.name} (${count} methods)`;
      })
      .join("\n");
  }

  // Group by domain for better discoverability
  const lines: string[] = [];
  for (const [domain, domainAdapters] of byDomain) {
    const adapterList = domainAdapters
      .map((a) => `${a.name}(${Object.keys(a.tools).length})`)
      .join(", ");
    lines.push(`[${domain}] ${adapterList}`);
  }
  return lines.join("\n");
}

/**
 * Infer domain from adapter name/description if not explicitly set.
 * Returns the adapter's explicit domain if set, otherwise infers from name/description.
 */
export function inferDomain(adapter: Adapter): string {
  if (adapter.domain) return adapter.domain;

  const name = adapter.name.toLowerCase();
  const desc = (adapter.description || "").toLowerCase();
  const combined = `${name} ${desc}`;

  const domains: Record<string, string[]> = {
    payments: ["stripe", "paypal", "square", "payment", "checkout", "billing", "invoice"],
    database: ["supabase", "postgres", "mysql", "mongodb", "redis", "database", "sql", "query"],
    email: ["sendgrid", "mailgun", "postmark", "email", "smtp", "mail"],
    storage: ["s3", "cloudflare", "storage", "blob", "file", "upload"],
    auth: ["auth", "oauth", "login", "jwt", "clerk", "auth0"],
    ai: ["openai", "anthropic", "claude", "gpt", "llm", "ai", "ml"],
    messaging: ["slack", "discord", "telegram", "twilio", "sms", "chat"],
    crm: ["hubspot", "salesforce", "crm", "customer"],
    analytics: ["analytics", "metrics", "tracking", "mixpanel", "amplitude"],
    devtools: ["github", "gitlab", "jira", "linear", "chrome", "devtools", "ci", "cd"],
  };

  for (const [domain, keywords] of Object.entries(domains)) {
    if (keywords.some((k) => combined.includes(k))) {
      return domain;
    }
  }

  return "general";
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
    const optional = param.required === true ? "" : "?";
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
