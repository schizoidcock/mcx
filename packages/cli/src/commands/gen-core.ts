/**
 * MCX Adapter Generator - Core Logic
 * Shared between CLI and TUI
 */
import * as path from "path";
import { parse as parseYAML } from "yaml";
import { getAdaptersDir } from "../utils/paths";

// ============================================================================
// Types (exported for use by CLI and TUI)
// ============================================================================

export interface OpenAPIParameter {
  name: string;
  in: "query" | "path" | "header";
  description?: string;
  required?: boolean;
  schema?: {
    type?: string;
    format?: string;
    enum?: string[];
    default?: unknown;
  };
}

export interface OpenAPIOperation {
  summary?: string;
  description?: string;
  parameters?: OpenAPIParameter[];
  requestBody?: {
    required?: boolean;
    content?: {
      "application/json"?: {
        schema?: Record<string, unknown>;
      };
    };
  };
  responses?: Record<string, unknown>;
}

export interface OpenAPIPath {
  get?: OpenAPIOperation;
  post?: OpenAPIOperation;
  put?: OpenAPIOperation;
  delete?: OpenAPIOperation;
  patch?: OpenAPIOperation;
}

export interface OpenAPISecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  scheme?: string;
  bearerFormat?: string;
  in?: "header" | "query" | "cookie";
  name?: string;
}

export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    description?: string;
    version: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, OpenAPIPath>;
  components?: {
    securitySchemes?: Record<string, OpenAPISecurityScheme>;
    schemas?: Record<string, unknown>;
  };
  securityDefinitions?: Record<string, OpenAPISecurityScheme>;
}

export interface DetectedAuth {
  type: "none" | "basic" | "bearer" | "apiKey";
  headerName?: string;
  in?: "header" | "query";
}

export interface DetectedSDK {
  packageName: string;
  importName: string;
  language: "typescript" | "python" | "go";
  initPattern: string;
}

export interface ParsedEndpoint {
  path: string;
  method: "get" | "post" | "put" | "delete" | "patch";
  operation: OpenAPIOperation;
  methodName: string;
  category: string;
}

export interface ParseResult {
  endpoints: ParsedEndpoint[];
  serverUrl: string | null;
  auth: DetectedAuth | null;
  sdk: DetectedSDK | null;
}

export interface SourceAnalysis {
  valid: boolean;
  error?: string;
  files: string[];
  filesWithSpecs: string[];
  filesWithoutSpecs: string[];
  endpoints: ParsedEndpoint[];
  serverUrl: string | null;
  auth: DetectedAuth | null;
  sdk: DetectedSDK | null;
  summary: string;
}

export interface GeneratorOptions {
  source: string;
  name?: string;
  output?: string;
  baseUrl?: string;
  auth?: DetectedAuth | string;
  readOnly?: boolean;
}

// ============================================================================
// File Discovery
// ============================================================================

export async function findMarkdownFiles(source: string): Promise<string[]> {
  const normalizedSource = source.replace(/^["']|["']$/g, "");
  const file = Bun.file(normalizedSource);

  if (normalizedSource.endsWith(".md") || normalizedSource.endsWith(".md.txt")) {
    if (await file.exists()) {
      return [normalizedSource];
    }
    throw new Error(`File not found: ${normalizedSource}`);
  }

  try {
    const glob = new Bun.Glob("**/*.{md,md.txt}");
    const files: string[] = [];
    for await (const f of glob.scan({ cwd: normalizedSource, onlyFiles: true })) {
      files.push(path.join(normalizedSource, f));
    }
    if (files.length > 0) return files;
    throw new Error(`No markdown files found in directory: ${normalizedSource}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("No markdown files")) {
      throw err;
    }
  }

  throw new Error(`Source must be a .md file or directory: ${normalizedSource}`);
}

// ============================================================================
// Parsing
// ============================================================================

export function parseMarkdownDoc(content: string, filePath: string): ParseResult {
  const endpoints: ParsedEndpoint[] = [];
  let spec: OpenAPISpec | null = null;
  let serverUrl: string | null = null;
  let auth: DetectedAuth | null = null;
  let sdk: DetectedSDK | null = null;

  // Try JSON (supports 3-4 backticks and extra text after language tag)
  const jsonMatch = content.match(/`{3,4}json[^\n]*\n([\s\S]*?)\n`{3,4}/);
  if (jsonMatch) {
    try {
      spec = JSON.parse(jsonMatch[1]);
    } catch {}
  }

  // Try YAML (supports 3-4 backticks and extra text after language tag)
  if (!spec) {
    const yamlMatch = content.match(/`{3,4}ya?ml[^\n]*\n([\s\S]*?)\n`{3,4}/);
    if (yamlMatch) {
      try {
        spec = parseYAML(yamlMatch[1]) as OpenAPISpec;
      } catch {}
    }
  }

  if (!spec || !spec.paths) return { endpoints, serverUrl, auth, sdk };

  // Extract server URL if available
  if (spec.servers && spec.servers.length > 0 && spec.servers[0].url) {
    serverUrl = spec.servers[0].url;
  }

  // Detect auth from security schemes
  auth = detectAuthFromSpec(spec);

  // Detect SDK from code examples
  sdk = detectSDKFromMarkdown(content);

  const category = extractCategory(filePath);

  for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
    const methods: Array<"get" | "post" | "put" | "delete" | "patch"> = ["get", "post", "put", "delete", "patch"];

    for (const method of methods) {
      const operation = pathObj[method];
      if (!operation) continue;

      endpoints.push({
        path: pathStr,
        method,
        operation,
        methodName: generateMethodName(method, pathStr, operation),
        category,
      });
    }
  }

  return { endpoints, serverUrl, auth, sdk };
}

export function detectAuthFromSpec(spec: OpenAPISpec): DetectedAuth | null {
  const schemes = spec.components?.securitySchemes || spec.securityDefinitions;
  if (!schemes) return null;

  const schemeNames = Object.keys(schemes);
  if (schemeNames.length === 0) return null;

  const scheme = schemes[schemeNames[0]];

  if (scheme.type === "http") {
    if (scheme.scheme === "bearer") {
      return { type: "bearer" };
    }
    if (scheme.scheme === "basic") {
      return { type: "basic" };
    }
  }

  if (scheme.type === "apiKey") {
    return {
      type: "apiKey",
      headerName: scheme.name || "X-API-Key",
      in: scheme.in || "header",
    };
  }

  return null;
}

export function detectSDKFromMarkdown(content: string): DetectedSDK | null {
  // Look for TypeScript SDK examples
  // SECURITY: Use non-greedy match without trailing \s* to prevent ReDoS
  // The pattern matches until the first ``` fence on its own line
  const tsMatch = content.match(/```typescript[^\n]*\n([\s\S]*?)\n```/);
  if (tsMatch) {
    const tsCode = tsMatch[1].trim();
    const importMatch = tsCode.match(/import\s+(?:\{\s*(\w+)\s*\}|(\w+))\s+from\s+["']([^"']+)["']/);
    if (importMatch) {
      const importName = importMatch[1] || importMatch[2];
      const packageName = importMatch[3];
      const initMatch = tsCode.match(/new\s+(\w+)\s*\(\s*\{([^}]*)\}\s*\)/);
      if (initMatch) {
        return {
          packageName,
          importName,
          language: "typescript",
          initPattern: initMatch[0],
        };
      }
    }
  }

  // Look for Python SDK examples
  // SECURITY: Use non-greedy match without trailing \s* to prevent ReDoS
  const pyMatch = content.match(/```python[^\n]*\n([\s\S]*?)\n```/);
  if (pyMatch) {
    const pyCode = pyMatch[1].trim();
    const importMatch = pyCode.match(/from\s+(\S+)\s+import\s+(\w+)/);
    if (importMatch) {
      const packageName = importMatch[1];
      const importName = importMatch[2];
      const initMatch = pyCode.match(/(\w+)\s*=\s*(\w+)\s*\(/);
      if (initMatch) {
        return {
          packageName,
          importName,
          language: "python",
          initPattern: `${importName}()`,
        };
      }
    }
  }

  return null;
}

function extractCategory(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  // Get immediate parent directory (the folder containing the file)
  const parent = parts[parts.length - 2];
  if (parent && !parent.includes(".")) {
    // Decode URL-encoded characters (e.g., %20 for space, %C3%A1 for á)
    try {
      return decodeURIComponent(parent);
    } catch {
      return parent;
    }
  }
  return "general";
}

function generateMethodName(method: string, pathStr: string, _operation: OpenAPIOperation): string {
  let cleaned = pathStr
    .replace(/\{([^}]+)\}/g, "ById")
    .replace(/[^a-zA-Z0-9]/g, " ")
    .trim()
    .split(/\s+/)
    .map((word, i) => (i === 0 ? word.toLowerCase() : capitalize(word)))
    .join("");

  const prefix =
    method === "get" ? "get" : method === "post" ? "create" : method === "put" ? "update" : method === "delete" ? "delete" : method;

  if (cleaned.toLowerCase().startsWith(prefix)) {
    return cleaned;
  }

  return prefix + capitalize(cleaned);
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * SECURITY: Escape a string for safe use in single-quoted JavaScript strings.
 * Prevents code injection via quote/backslash breakout.
 */
function escapeForSingleQuote(str: string): string {
  return str
    .replace(/\\/g, "\\\\")  // Escape backslashes first
    .replace(/'/g, "\\'")     // Escape single quotes
    .replace(/[\r\n]+/g, " ") // Remove newlines
    .replace(/[\x00-\x1f\x7f]/g, ""); // Remove control characters
}

/**
 * SECURITY: Escape a string for safe use in template literals (backtick strings).
 * Prevents code injection via backtick breakout and ${} interpolation.
 */
function escapeForTemplateLiteral(str: string): string {
  return str
    .replace(/\\/g, "\\\\")   // Escape backslashes first
    .replace(/`/g, "\\`")     // Escape backticks
    .replace(/\$\{/g, "\\${") // Escape ${} interpolation
    .replace(/[\r\n]+/g, " ") // Remove newlines
    .replace(/[\x00-\x1f\x7f]/g, ""); // Remove control characters
}

/**
 * SECURITY: Validate that a string is a safe JavaScript identifier.
 * Used for names that will be used as bare identifiers in generated code.
 */
function isValidIdentifier(str: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}

/**
 * SECURITY: Validate npm package name format to prevent injection in import statements.
 */
function isValidPackageName(str: string): boolean {
  // npm package names: lowercase, can have @scope/, hyphens, underscores
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(str);
}

export function groupByCategory(endpoints: ParsedEndpoint[]): Record<string, ParsedEndpoint[]> {
  const groups: Record<string, ParsedEndpoint[]> = {};
  for (const ep of endpoints) {
    if (!groups[ep.category]) groups[ep.category] = [];
    groups[ep.category].push(ep);
  }
  return groups;
}

// ============================================================================
// Endpoint Filtering
// ============================================================================

export interface FilterOptions {
  include?: string[];  // Categories or method names to include
  exclude?: string[];  // Categories or method names to exclude
}

/**
 * Filter endpoints by category or method name
 * - Matches against category (folder name) or methodName
 * - Case-insensitive partial matching
 */
export function filterEndpoints(endpoints: ParsedEndpoint[], options: FilterOptions): ParsedEndpoint[] {
  let filtered = endpoints;

  if (options.include && options.include.length > 0) {
    const patterns = options.include.map(p => p.toLowerCase());
    filtered = filtered.filter(ep => {
      const category = ep.category.toLowerCase();
      const methodName = ep.methodName.toLowerCase();
      return patterns.some(p => category.includes(p) || methodName.includes(p));
    });
  }

  if (options.exclude && options.exclude.length > 0) {
    const patterns = options.exclude.map(p => p.toLowerCase());
    filtered = filtered.filter(ep => {
      const category = ep.category.toLowerCase();
      const methodName = ep.methodName.toLowerCase();
      return !patterns.some(p => category.includes(p) || methodName.includes(p));
    });
  }

  return filtered;
}

// ============================================================================
// Source Analysis (combines discovery + parsing)
// ============================================================================

export async function analyzeSource(source: string): Promise<SourceAnalysis> {
  try {
    const files = await findMarkdownFiles(source);
    const endpoints: ParsedEndpoint[] = [];
    const filesWithSpecs: string[] = [];
    const filesWithoutSpecs: string[] = [];
    let serverUrl: string | null = null;
    let auth: DetectedAuth | null = null;
    let sdk: DetectedSDK | null = null;

    for (const file of files) {
      try {
        const content = await Bun.file(file).text();
        const result = parseMarkdownDoc(content, file);
        if (result.endpoints.length > 0) {
          endpoints.push(...result.endpoints);
          filesWithSpecs.push(file);
          if (!serverUrl && result.serverUrl) serverUrl = result.serverUrl;
          if (!auth && result.auth) auth = result.auth;
          if (!sdk && result.sdk) sdk = result.sdk;
        } else {
          filesWithoutSpecs.push(file);
        }
      } catch {
        filesWithoutSpecs.push(file);
      }
    }

    if (endpoints.length === 0) {
      return {
        valid: false,
        error: "No OpenAPI specifications found",
        files,
        filesWithSpecs: [],
        filesWithoutSpecs: files,
        endpoints: [],
        serverUrl: null,
        auth: null,
        sdk: null,
        summary: "",
      };
    }

    const summary = `${filesWithSpecs.length} file(s), ${endpoints.length} endpoints`;

    return {
      valid: true,
      files,
      filesWithSpecs,
      filesWithoutSpecs,
      endpoints,
      serverUrl,
      auth,
      sdk,
      summary,
    };
  } catch (err) {
    return {
      valid: false,
      error: (err as Error).message,
      files: [],
      filesWithSpecs: [],
      filesWithoutSpecs: [],
      endpoints: [],
      serverUrl: null,
      auth: null,
      sdk: null,
      summary: "",
    };
  }
}

// ============================================================================
// API Name Extraction
// ============================================================================

export async function extractApiName(source: string): Promise<string | null> {
  try {
    const files = await findMarkdownFiles(source);
    if (files.length === 0) return null;

    const content = await Bun.file(files[0]).text();

    // Try JSON
    const jsonMatch = content.match(/`{3,}json[^\n]*\n([\s\S]*?)\n`{3,}/);
    if (jsonMatch) {
      try {
        const spec = JSON.parse(jsonMatch[1]);
        if (spec.servers?.[0]?.url) {
          return extractNameFromUrl(spec.servers[0].url);
        }
      } catch {}
    }

    // Try YAML
    const yamlMatch = content.match(/`{3,}ya?ml[^\n]*\n([\s\S]*?)\n`{3,}/);
    if (yamlMatch) {
      try {
        const spec = parseYAML(yamlMatch[1]);
        if (spec?.servers?.[0]?.url) {
          return extractNameFromUrl(spec.servers[0].url);
        }
      } catch {}
    }
  } catch {}

  return null;
}

function extractNameFromUrl(urlString: string): string | null {
  try {
    const url = new URL(urlString);
    const hostParts = url.hostname.split(".");
    if (hostParts[0] === "api" && hostParts.length > 1) {
      return hostParts[1];
    }
    return hostParts[0] === "www" ? hostParts[1] : hostParts[0];
  } catch {
    return null;
  }
}

// ============================================================================
// Default Output Path
// ============================================================================

export function getDefaultOutput(name: string): string {
  const adaptersDir = getAdaptersDir();
  const resolved = path.resolve(adaptersDir, `${name}.ts`);

  // SECURITY: Ensure output path stays within adapters directory (prevent path traversal)
  const normalizedAdaptersDir = path.resolve(adaptersDir);
  if (!resolved.startsWith(normalizedAdaptersDir + path.sep) && resolved !== normalizedAdaptersDir) {
    throw new Error(`Invalid adapter name: path traversal detected`);
  }

  return resolved;
}

export function getDefaultName(source: string): string {
  return path.basename(source).replace(/[^a-zA-Z0-9]/g, "_");
}

// ============================================================================
// Code Generation
// ============================================================================

export function generateAdapter(name: string, endpoints: ParsedEndpoint[], baseUrl: string, auth?: DetectedAuth | string | null): string {
  // SECURITY: Validate name is a safe identifier
  if (!isValidIdentifier(name)) {
    throw new Error(`Invalid adapter name "${name}": must be a valid JavaScript identifier`);
  }

  const lines: string[] = [];
  const envPrefix = name.toUpperCase();

  // SECURITY: Escape baseUrl for safe use in single-quoted string
  const safeBaseUrl = escapeForSingleQuote(baseUrl);

  // Normalize auth to DetectedAuth
  let authConfig: DetectedAuth | null = null;
  if (typeof auth === "string") {
    if (auth === "bearer") authConfig = { type: "bearer" };
    else if (auth === "apikey") authConfig = { type: "apiKey", headerName: "X-API-Key" };
    else if (auth === "basic") authConfig = { type: "basic" };
    else if (auth === "none") authConfig = { type: "none" };
  } else {
    authConfig = auth || null;
  }

  // Header
  lines.push(`/**`);
  lines.push(` * ${capitalize(name)} API Adapter - Auto-generated by MCX`);
  lines.push(` * Generated: ${new Date().toISOString()}`);
  lines.push(` * Endpoints: ${endpoints.length}`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import { defineAdapter } from '@papicandela/mcx-adapters';`);
  lines.push(``);
  lines.push(`const BASE_URL = process.env.${envPrefix}_API_URL || '${safeBaseUrl}';`);
  lines.push(``);

  // Auth helper
  if (authConfig?.type === "bearer") {
    lines.push(`function getAuthHeader(): string {`);
    lines.push(`  const token = process.env.${envPrefix}_TOKEN;`);
    lines.push(`  if (!token) throw new Error('${envPrefix}_TOKEN environment variable is required');`);
    lines.push(`  return \`Bearer \${token}\`;`);
    lines.push(`}`);
  } else if (authConfig?.type === "apiKey") {
    // SECURITY: Escape headerName for safe use in single-quoted string
    const headerName = escapeForSingleQuote(authConfig.headerName || "X-API-Key");
    lines.push(`function getAuthHeader(): string {`);
    lines.push(`  const apiKey = process.env.${envPrefix}_API_KEY;`);
    lines.push(`  if (!apiKey) throw new Error('${envPrefix}_API_KEY environment variable is required');`);
    lines.push(`  return apiKey;`);
    lines.push(`}`);
    lines.push(``);
    lines.push(`const AUTH_HEADER_NAME = '${headerName}';`);
  } else if (authConfig?.type !== "none") {
    lines.push(`function getAuthHeader(): string {`);
    lines.push(`  const email = process.env.${envPrefix}_EMAIL;`);
    lines.push(`  const token = process.env.${envPrefix}_TOKEN;`);
    lines.push(`  if (!email || !token) throw new Error('${envPrefix}_EMAIL and ${envPrefix}_TOKEN are required');`);
    lines.push(`  return \`Basic \${Buffer.from(\`\${email}:\${token}\`).toString('base64')}\`;`);
    lines.push(`}`);
  }
  lines.push(``);

  // Fetch helper
  const isApiKey = authConfig?.type === "apiKey";
  const noAuth = authConfig?.type === "none";
  const authHeader = noAuth ? "" : isApiKey ? "[AUTH_HEADER_NAME]: getAuthHeader()," : "'Authorization': getAuthHeader(),";

  lines.push(`async function apiFetch<T>(endpoint: string, params?: Record<string, unknown>, options?: { method?: string; body?: unknown }): Promise<T> {`);
  lines.push(`  const url = new URL(\`\${BASE_URL}\${endpoint}\`);`);
  lines.push(`  if (params && (!options?.method || options.method === 'GET')) {`);
  lines.push(`    Object.entries(params).forEach(([key, value]) => {`);
  lines.push(`      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));`);
  lines.push(`    });`);
  lines.push(`  }`);
  lines.push(`  const response = await fetch(url.toString(), {`);
  lines.push(`    method: options?.method || 'GET',`);
  lines.push(`    headers: {`);
  if (authHeader) lines.push(`      ${authHeader}`);
  lines.push(`      'Content-Type': 'application/json',`);
  lines.push(`    },`);
  lines.push(`    body: options?.body ? JSON.stringify(options.body) : undefined,`);
  lines.push(`  });`);
  lines.push(`  if (!response.ok) {`);
  lines.push(`    const error = await response.text();`);
  lines.push(`    throw new Error(\`${capitalize(name)} API error (\${response.status}): \${error}\`);`);
  lines.push(`  }`);
  lines.push(`  return response.json() as T;`);
  lines.push(`}`);
  lines.push(``);

  // Adapter definition
  lines.push(`export const ${name} = defineAdapter({`);
  lines.push(`  name: '${name}',`);
  lines.push(`  description: '${capitalize(name)} API - ${endpoints.length} endpoints',`);
  lines.push(`  tools: {`);

  const seenMethods = new Set<string>();
  for (const ep of endpoints) {
    let methodName = ep.methodName;
    let suffix = 1;
    while (seenMethods.has(methodName)) {
      methodName = `${ep.methodName}${suffix++}`;
    }
    seenMethods.add(methodName);
    lines.push(generateMethod(methodName, ep));
  }

  lines.push(`  },`);
  lines.push(`});`);
  lines.push(``);

  return lines.join("\n");
}

export function generateSDKAdapter(name: string, endpoints: ParsedEndpoint[], sdk: DetectedSDK): string {
  // SECURITY: Validate name is a safe identifier
  if (!isValidIdentifier(name)) {
    throw new Error(`Invalid adapter name "${name}": must be a valid JavaScript identifier`);
  }

  // SECURITY: Validate sdk.importName is a safe identifier
  if (!isValidIdentifier(sdk.importName)) {
    throw new Error(`Invalid SDK import name "${sdk.importName}": must be a valid JavaScript identifier`);
  }

  // SECURITY: Validate sdk.packageName is a valid npm package name
  if (!isValidPackageName(sdk.packageName)) {
    throw new Error(`Invalid SDK package name "${sdk.packageName}": must be a valid npm package name`);
  }

  const lines: string[] = [];
  const envPrefix = name.toUpperCase();

  lines.push(`/**`);
  lines.push(` * ${capitalize(name)} SDK Adapter - Auto-generated by MCX`);
  lines.push(` * Generated: ${new Date().toISOString()}`);
  lines.push(` * SDK: ${sdk.packageName}`);
  lines.push(` * Endpoints: ${endpoints.length}`);
  lines.push(` */`);
  lines.push(``);
  lines.push(`import { defineAdapter } from '@papicandela/mcx-adapters';`);
  lines.push(`import { ${sdk.importName} } from '${sdk.packageName}';`);
  lines.push(``);

  lines.push(`function getClient(): ${sdk.importName} {`);
  lines.push(`  const apiKey = process.env.${envPrefix}_API_KEY;`);
  lines.push(`  if (!apiKey) throw new Error('${envPrefix}_API_KEY environment variable is required');`);
  lines.push(`  return new ${sdk.importName}({ apiKey });`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`export const ${name} = defineAdapter({`);
  lines.push(`  name: '${name}',`);
  lines.push(`  description: '${capitalize(name)} SDK - ${endpoints.length} endpoints',`);
  lines.push(`  tools: {`);

  const seenMethods = new Set<string>();
  for (const ep of endpoints) {
    let methodName = ep.methodName;
    let suffix = 1;
    while (seenMethods.has(methodName)) {
      methodName = `${ep.methodName}${suffix++}`;
    }
    seenMethods.add(methodName);
    lines.push(generateSDKMethod(methodName, ep));
  }

  lines.push(`  },`);
  lines.push(`});`);
  lines.push(``);

  return lines.join("\n");
}

function generateMethod(methodName: string, ep: ParsedEndpoint): string {
  const lines: string[] = [];
  const indent = "    ";

  // SECURITY: Escape backslashes BEFORE single quotes to prevent injection
  const desc = (ep.operation.summary || ep.operation.description || ep.path)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200);

  lines.push(`${indent}${methodName}: {`);
  lines.push(`${indent}  description: '${desc}',`);
  lines.push(`${indent}  parameters: ${generateParametersObject(ep)},`);

  const hasParams = (ep.operation.parameters || []).length > 0 || !!ep.operation.requestBody;
  const paramName = hasParams ? "params" : "_params";

  lines.push(`${indent}  execute: async (${paramName}: Record<string, unknown>) => {`);
  lines.push(`${indent}    ${generateExecuteFunction(ep)}`);
  lines.push(`${indent}  },`);
  lines.push(`${indent}},`);

  return lines.join("\n");
}

function generateSDKMethod(methodName: string, ep: ParsedEndpoint): string {
  const lines: string[] = [];
  const indent = "    ";

  // SECURITY: Escape backslashes BEFORE single quotes to prevent injection
  const desc = (ep.operation.summary || ep.operation.description || ep.path)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 200);

  lines.push(`${indent}${methodName}: {`);
  lines.push(`${indent}  description: '${desc}',`);
  lines.push(`${indent}  parameters: ${generateParametersObject(ep)},`);

  const hasParams = (ep.operation.parameters || []).length > 0 || !!ep.operation.requestBody;
  const paramName = hasParams ? "params" : "_params";

  const sdkMethodChain = deriveSDKMethodChain(ep);

  lines.push(`${indent}  execute: async (${paramName}: Record<string, unknown>) => {`);
  lines.push(`${indent}    const client = getClient();`);
  lines.push(`${indent}    return client.${sdkMethodChain}(${hasParams ? "params" : ""});`);
  lines.push(`${indent}  },`);
  lines.push(`${indent}},`);

  return lines.join("\n");
}

function deriveSDKMethodChain(ep: ParsedEndpoint): string {
  const { path: pathStr, method } = ep;
  const segments = pathStr.split("/").filter(Boolean);
  if (segments.length === 0) return "unknown";

  const resource = segments[0].replace(/s$/, "");
  let action: string;
  const hasPathParam = pathStr.includes("{");

  if (method === "get") {
    action = hasPathParam ? "get" : "listAll";
  } else if (method === "post") {
    action = "create";
  } else if (method === "put" || method === "patch") {
    action = "update";
  } else if (method === "delete") {
    action = "delete";
  } else {
    action = method;
  }

  return `${resource}.${action}`;
}

function generateParametersObject(ep: ParsedEndpoint): string {
  const params = ep.operation.parameters || [];
  const hasRequestBody = !!ep.operation.requestBody;

  if (params.length === 0 && !hasRequestBody) return "{}";

  const fields: string[] = [];

  for (const param of params) {
    if (param.in === "header") continue;
    const paramType = mapToParamType(param.schema);
    const desc = (param.description || "").replace(/'/g, "\\'").replace(/[\r\n]+/g, " ").slice(0, 100);
    const safeName = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param.name) ? param.name : `'${param.name}'`;
    fields.push(`      ${safeName}: { type: '${paramType}', description: '${desc}'${param.required ? ", required: true" : ""} }`);
  }

  if (hasRequestBody) {
    fields.push(`      body: { type: 'object', description: 'Request body' }`);
  }

  return `{\n${fields.join(",\n")}\n    }`;
}

function mapToParamType(schema?: OpenAPIParameter["schema"]): string {
  if (!schema) return "string";
  switch (schema.type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "string";
  }
}

function generateExecuteFunction(ep: ParsedEndpoint): string {
  const { method, path: pathStr } = ep;
  const params = ep.operation.parameters || [];

  // SECURITY: Only use path params that are valid identifiers
  const pathParams = params.filter((p) => p.in === "path" && isValidIdentifier(p.name));

  // Build URL expression with safe parameter substitution
  // SECURITY: Use escapeForTemplateLiteral since the path is embedded in a template literal
  let urlExpr = `\`${escapeForTemplateLiteral(pathStr)}\``;
  if (pathParams.length > 0) {
    // Only substitute params that are valid identifiers
    urlExpr = urlExpr.replace(/\{([^}]+)\}/g, (match, paramName) => {
      if (isValidIdentifier(paramName)) {
        return `\${params.${paramName}}`;
      }
      // Keep original placeholder if not a valid identifier (will fail at runtime, but safely)
      return match;
    });
  }

  // SECURITY: Only use query params that are valid identifiers
  const queryParams = params.filter((p) => p.in === "query" && isValidIdentifier(p.name));
  const queryObj = queryParams.length > 0
    ? `{ ${queryParams.map((p) => `${p.name}: params.${p.name}`).join(", ")} }`
    : "";

  if (method === "get") {
    return queryParams.length > 0 ? `return apiFetch(${urlExpr}, ${queryObj});` : `return apiFetch(${urlExpr});`;
  } else if (method === "delete") {
    return `return apiFetch(${urlExpr}, ${queryObj || "undefined"}, { method: 'DELETE' });`;
  } else {
    return `return apiFetch(${urlExpr}, ${queryObj || "undefined"}, { method: '${method.toUpperCase()}', body: params.body });`;
  }
}

// ============================================================================
// Auth Description Helper
// ============================================================================

export function getAuthDescription(auth: DetectedAuth | null): string {
  if (!auth) return "none";
  if (auth.type === "apiKey") {
    return `apiKey (${auth.headerName || "X-API-Key"})`;
  }
  return auth.type;
}
