/**
 * MCX Adapter Generator
 *
 * Generates adapter code from OpenAPI specs embedded in Markdown files.
 * Supports OpenAPI 3.0.x, 3.1.x, 3.2.x in JSON or YAML format.
 */

import { parse as parseYAML } from 'yaml';

// ============================================================================
// Types
// ============================================================================

interface OpenAPISpec {
  openapi: string;
  info?: {
    title?: string;
    description?: string;
    version?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths?: Record<string, PathItem>;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  patch?: Operation;
  delete?: Operation;
  parameters?: Parameter[];
}

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses?: Record<string, Response>;
}

interface Parameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: Schema;
}

interface Schema {
  type?: string;
  format?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

interface RequestBody {
  description?: string;
  required?: boolean;
  content?: Record<string, { schema?: Schema }>;
}

interface Response {
  description?: string;
}

interface GeneratorOptions {
  /** Name of the adapter */
  name: string;
  /** Source: file path or directory */
  source: string;
  /** Output file path (optional, defaults to stdout) */
  output?: string;
  /** HTTP methods to include (default: all) */
  methods?: ('get' | 'post' | 'put' | 'patch' | 'delete')[];
  /** Base URL override */
  baseUrl?: string;
  /** Auth type: basic, bearer, apikey, none */
  auth?: 'basic' | 'bearer' | 'apikey' | 'none';
  /** Recursive directory scan (default: true) */
  recursive?: boolean;
  /** Generate read-only adapter (GET methods only) */
  readOnly?: boolean;
}

interface ParsedEndpoint {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  description: string;
  parameters: Parameter[];
  hasBody: boolean;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Extract OpenAPI spec from markdown content.
 * Supports both JSON and YAML code blocks.
 */
export function extractOpenAPIFromMarkdown(content: string): OpenAPISpec | null {
  // Try JSON first
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const spec = JSON.parse(jsonMatch[1]);
      if (spec.openapi && spec.paths) {
        return spec as OpenAPISpec;
      }
    } catch {
      // Not valid JSON, try YAML
    }
  }

  // Try YAML
  const yamlMatch = content.match(/```ya?ml\s*([\s\S]*?)```/);
  if (yamlMatch) {
    try {
      const spec = parseYAML(yamlMatch[1]);
      if (spec.openapi && spec.paths) {
        return spec as OpenAPISpec;
      }
    } catch {
      // Not valid YAML
    }
  }

  return null;
}

/**
 * Parse an OpenAPI spec and extract endpoint information.
 */
export function parseOpenAPISpec(spec: OpenAPISpec, options: Pick<GeneratorOptions, 'methods' | 'readOnly'>): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = [];
  const allowedMethods = options.readOnly
    ? ['get']
    : (options.methods || ['get', 'post', 'put', 'patch', 'delete']);

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    // Get path-level parameters
    const pathParams = pathItem.parameters || [];

    for (const method of allowedMethods) {
      const operation = pathItem[method as keyof PathItem] as Operation | undefined;
      if (!operation || typeof operation !== 'object') continue;

      // Merge path and operation parameters
      const allParams = [...pathParams, ...(operation.parameters || [])];

      // Generate operationId if not present
      const operationId = operation.operationId || generateOperationId(method, path);

      endpoints.push({
        path,
        method,
        operationId,
        summary: operation.summary || '',
        description: operation.description || operation.summary || '',
        parameters: allParams,
        hasBody: !!operation.requestBody,
      });
    }
  }

  return endpoints;
}

/**
 * Generate an operationId from method and path.
 * e.g., GET /invoices/{id} -> getInvoicesById
 */
function generateOperationId(method: string, path: string): string {
  const parts = path
    .split('/')
    .filter(Boolean)
    .map(part => {
      if (part.startsWith('{') && part.endsWith('}')) {
        return 'By' + capitalize(part.slice(1, -1));
      }
      return capitalize(part.replace(/-/g, '_'));
    });

  return method.toLowerCase() + parts.join('');
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================================================
// Code Generator
// ============================================================================

/**
 * Generate TypeScript adapter code from parsed endpoints.
 */
export function generateAdapterCode(
  name: string,
  endpoints: ParsedEndpoint[],
  options: Pick<GeneratorOptions, 'baseUrl' | 'auth'>
): string {
  const baseUrl = options.baseUrl || 'https://api.example.com';
  const auth = options.auth || 'none';

  // Group endpoints by tag or path prefix
  const methodsCode = endpoints.map(ep => generateMethodCode(ep)).join('\n\n');

  const authCode = generateAuthCode(auth, name);
  const fetchCode = generateFetchCode(auth);

  return `/**
 * Auto-generated adapter: ${name}
 * Generated by MCX Adapter Generator
 *
 * Endpoints: ${endpoints.length}
 */

import { defineAdapter } from '@mcx/adapters';

${authCode}

// Lazy getter - read env at runtime, not at import time
function getBaseUrl(): string {
  return process.env.${name.toUpperCase()}_API_URL || '${baseUrl}';
}

${fetchCode}

export const ${name} = defineAdapter({
  name: '${name}',
  description: 'Auto-generated adapter for ${name} API',
  tools: {
${methodsCode}
  },
});
`;
}

function generateAuthCode(auth: string, adapterName: string): string {
  const envPrefix = adapterName.toUpperCase();
  switch (auth) {
    case 'basic':
      return `function getAuthHeader(): string {
  const user = process.env.${envPrefix}_USER || process.env.${envPrefix}_EMAIL;
  const pass = process.env.${envPrefix}_PASS || process.env.${envPrefix}_TOKEN;
  if (!user || !pass) {
    throw new Error('Authentication credentials not configured');
  }
  return \`Basic \${Buffer.from(\`\${user}:\${pass}\`).toString('base64')}\`;
}`;
    case 'bearer':
      return `function getAuthHeader(): string {
  const token = process.env.${envPrefix}_TOKEN || process.env.${envPrefix}_API_KEY;
  if (!token) {
    throw new Error('Authentication token not configured');
  }
  return \`Bearer \${token}\`;
}`;
    case 'apikey':
      return `function getApiKey(): string {
  const key = process.env.${envPrefix}_API_KEY;
  if (!key) {
    throw new Error('API key not configured');
  }
  return key;
}`;
    default:
      return '// No authentication configured';
  }
}

function generateFetchCode(auth: string): string {
  const authHeader = auth === 'none' ? '' : `
      'Authorization': getAuthHeader(),`;

  const apiKeyParam = auth === 'apikey' ? `
  // Add API key to params
  params.api_key = getApiKey();` : '';

  return `async function apiFetch<T>(
  endpoint: string,
  params?: Record<string, unknown>,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const method = options?.method || 'GET';
  const url = new URL(\`\${getBaseUrl()}\${endpoint}\`);
${apiKeyParam}

  if (params && method === 'GET') {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {${authHeader}
      'Content-Type': 'application/json',
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(\`API error (\${response.status}): \${error}\`);
  }

  return response.json();
}`;
}

function generateMethodCode(endpoint: ParsedEndpoint): string {
  const { operationId, summary, description, parameters, path, method, hasBody } = endpoint;

  // Build parameters schema
  const paramsSchema = parameters
    .filter(p => p.in === 'query' || p.in === 'path')
    .map(p => {
      const typeMap: Record<string, string> = {
        'integer': 'number',
        'number': 'number',
        'boolean': 'boolean',
        'string': 'string',
      };
      const type = typeMap[p.schema?.type || 'string'] || 'string';
      return `        ${p.name}: { type: '${type}', description: '${(p.description || '').replace(/'/g, "\\'")}', required: ${p.required || false} }`;
    })
    .join(',\n');

  // Build path with parameter substitution
  const pathWithParams = path.replace(/\{(\w+)\}/g, '${params.$1}');

  // Build execute function
  const queryParams = parameters.filter(p => p.in === 'query').map(p => p.name);

  let queryObj = '';
  if (queryParams.length > 0) {
    queryObj = `{ ${queryParams.map(p => p).join(', ')} }`;
  }

  const methodUpper = method.toUpperCase();
  const fetchCall = methodUpper === 'GET'
    ? `apiFetch(\`${pathWithParams}\`${queryParams.length ? `, ${queryObj}` : ''})`
    : `apiFetch(\`${pathWithParams}\`, ${queryParams.length ? queryObj : 'undefined'}, { method: '${methodUpper}'${hasBody ? ', body: params.body' : ''} })`;

  return `    ${operationId}: {
      description: '${(summary || description).replace(/'/g, "\\'")}',
      parameters: {
${paramsSchema || '        // No parameters'}
      },
      execute: async (params: Record<string, unknown>) => {
        return ${fetchCall};
      },
    },`;
}

// ============================================================================
// Main Generator Function
// ============================================================================

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

/**
 * Generate adapter from OpenAPI specs in markdown files.
 */
export async function generateAdapter(options: GeneratorOptions): Promise<string> {
  const { source, name, recursive = true } = options;

  // Check if source is file or directory
  const sourceStats = await stat(source);
  const mdFiles: string[] = [];

  if (sourceStats.isFile()) {
    mdFiles.push(source);
  } else if (sourceStats.isDirectory()) {
    await collectMdFiles(source, mdFiles, recursive);
  } else {
    throw new Error(`Source is not a file or directory: ${source}`);
  }

  if (mdFiles.length === 0) {
    throw new Error(`No markdown files found in: ${source}`);
  }

  // Parse all files
  const allEndpoints: ParsedEndpoint[] = [];

  for (const file of mdFiles) {
    const content = await readFile(file, 'utf-8');
    const spec = extractOpenAPIFromMarkdown(content);

    if (spec) {
      const endpoints = parseOpenAPISpec(spec, options);
      allEndpoints.push(...endpoints);
    }
  }

  if (allEndpoints.length === 0) {
    throw new Error('No OpenAPI endpoints found in the provided files');
  }

  // Deduplicate by operationId
  const uniqueEndpoints = deduplicateEndpoints(allEndpoints);

  // Generate code
  const code = generateAdapterCode(name, uniqueEndpoints, options);

  // Output
  if (options.output) {
    await writeFile(options.output, code, 'utf-8');
    return `Generated ${uniqueEndpoints.length} endpoints to ${options.output}`;
  }

  return code;
}

async function collectMdFiles(dir: string, files: string[], recursive: boolean): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(fullPath);
    } else if (entry.isDirectory() && recursive) {
      await collectMdFiles(fullPath, files, recursive);
    }
  }
}

function deduplicateEndpoints(endpoints: ParsedEndpoint[]): ParsedEndpoint[] {
  const seen = new Map<string, ParsedEndpoint>();

  for (const ep of endpoints) {
    const key = `${ep.method}:${ep.path}`;
    if (!seen.has(key)) {
      seen.set(key, ep);
    }
  }

  return Array.from(seen.values());
}

// Export for CLI
export type { GeneratorOptions };
