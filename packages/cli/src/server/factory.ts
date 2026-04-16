/**
 * MCP Server Factory
 *
 * Creates and configures MCX MCP servers.
 * Central location for server creation logic.
 *
 * Linus principles:
 * - One source of truth for server creation
 * - Types exported for use by other modules
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import pc from "picocolors";
import { getMcxHomeDir } from "../utils/paths.js";
import { isDangerousEnvKey } from "../utils/security.js";

// ============================================================================
// Types
// ============================================================================

export interface Skill {
  name: string;
  description?: string;
  inputs?: Record<string, { type: string; description?: string; default?: unknown }>;
  run: (ctx: { inputs: Record<string, unknown> }) => Promise<unknown>;
}

export interface AdapterMethod {
  description: string;
  parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
  execute: (params: unknown) => Promise<unknown>;
}

export interface Adapter {
  name: string;
  description?: string;
  domain?: string;
  tools: Record<string, AdapterMethod>;
  __lazy?: boolean;
  __path?: string;
}

export interface MCXConfig {
  adapters?: Adapter[];
  sandbox?: {
    timeout?: number;
    memoryLimit?: number;
  };
  env?: Record<string, string | undefined>;
}

// ============================================================================
// Environment Loading
// ============================================================================

/**
 * Load environment variables from a .env file
 * Returns the number of variables loaded
 * SECURITY: Validates key names and blocks dangerous variable overwrites
 */
async function loadEnvFromPath(envPath: string, label: string): Promise<number> {
  const file = Bun.file(envPath);

  if (!(await file.exists())) {
    return 0;
  }

  try {
    const content = await file.text();
    let loaded = 0;
    let skipped = 0;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // SECURITY: Validate key is a safe identifier pattern
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        console.error(pc.yellow(`Warning: Skipped invalid env key "${key}" in ${label}`));
        skipped++;
        continue;
      }

      // SECURITY: Block dangerous environment variables
      if (isDangerousEnvKey(key)) {
        console.error(pc.yellow(`Warning: Skipped dangerous env key "${key}" in ${label}`));
        skipped++;
        continue;
      }

      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
      loaded++;
    }

    if (loaded > 0) {
      console.error(pc.dim(`Loaded ${loaded} env var(s) from ${label}${skipped > 0 ? ` (${skipped} skipped)` : ""}`));
    }
    return loaded;
  } catch (error) {
    console.error(pc.yellow(`Warning: Failed to load ${label}: ${error}`));
    return 0;
  }
}

/**
 * Load environment variables from global MCX home directory
 * e.g., ~/.mcx/.env
 */
export async function loadEnvFile(): Promise<void> {
  const mcxHome = getMcxHomeDir();
  const envPath = join(mcxHome, ".env");
  await loadEnvFromPath(envPath, "~/.mcx");
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load MCX config from mcx.config.ts in current directory
 */
export async function loadConfig(): Promise<MCXConfig | null> {
  const configPath = join(process.cwd(), "mcx.config.ts");
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    return null;
  }

  try {
    console.error(pc.dim(`Loading config: ${configPath}`));
    const configModule = await import(configPath);
    const config = configModule.default || configModule;
    console.error(pc.dim(`Loaded ${config?.adapters?.length || 0} adapter(s)`));

    // Copy config.env to process.env for adapters that read from process.env
    // SECURITY: Apply same validation as .env files
    if (config?.env) {
      let injected = 0;
      for (const [key, value] of Object.entries(config.env)) {
        if (value === undefined || value === null) continue;

        // SECURITY: Block dangerous environment variables from config.env
        if (isDangerousEnvKey(key)) {
          console.error(pc.yellow(`Warning: Skipped dangerous env key "${key}" in config.env`));
          continue;
        }

        process.env[key] = String(value);
        injected++;
      }
      console.error(pc.dim(`Injected ${injected} env var(s) from config.env`));
    }

    return config;
  } catch (error) {
    console.error(pc.yellow(`Warning: Failed to load mcx.config.ts: ${error instanceof Error ? error.message : String(error)}`));
    return null;
  }
}

// ============================================================================
// Skills Loading
// ============================================================================

/**
 * Load skills from skills/ directory in current project
 */
export async function loadSkills(): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const skillsDir = join(process.cwd(), "skills");

  if (!existsSync(skillsDir)) {
    return skills;
  }

  // Use Bun.Glob to find skill files
  const glob = new Bun.Glob("**/*.{ts,js}");

  for await (const path of glob.scan({ cwd: skillsDir, onlyFiles: true })) {
    const fullPath = join(skillsDir, path);

    // Skip index files in subdirectories for now, handle them separately
    if (path.includes("/") && !path.endsWith("/index.ts") && !path.endsWith("/index.js")) {
      continue;
    }

    try {
      const skillModule = await import(fullPath);
      const skill = skillModule.default || skillModule;

      if (skill && typeof skill.run === "function") {
        const skillName = skill.name || path.replace(/\/(index)?\.(ts|js)$/, "").replace(/\.(ts|js)$/, "");
        skills.set(skillName, skill);
      }
    } catch (error) {
      console.error(pc.yellow(`Warning: Failed to load skill ${path}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  return skills;
}

// ============================================================================
// Adapter Loading Helpers
// ============================================================================

/** Convert kebab-case to camelCase: "chrome-devtools" -> "chromeDevtools" */
export function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Cache of fully loaded adapters (loaded on first use) */
const loadedAdapters = new Map<string, Adapter>();

// Types for lazy adapter metadata
type ParamDef = { type: string; description?: string; required?: boolean };
type MethodMeta = { name: string; description?: string; params?: Record<string, ParamDef> };

/** Parse single param: { type: "string", required?: bool, description?: "..." } */
function parseParam(block: string): ParamDef {
  const type = block.match(/type:\s*["'](\w+)["']/)?.[1] || "string";
  const required = /required:\s*true/.test(block);
  const desc = block.match(/description:\s*["']([^"']+)["']/)?.[1];
  return { type, required, description: desc };
}

/** Parse parameters block - handles nested braces */
function parseParamsBlock(content: string, start: number): Record<string, ParamDef> | undefined {
  const params: Record<string, ParamDef> = {};
  let depth = 0, blockStart = -1, paramName = "";

  for (let i = start; i < content.length; i++) {
    const c = content[i];
    if (c === "{") {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && paramName && blockStart !== -1) {
        params[paramName] = parseParam(content.slice(blockStart, i + 1));
        paramName = "";
        blockStart = -1;
      }
      if (depth < 0) break;
    } else if (depth === 0) {
      const nameMatch = content.slice(i).match(/^(\w+)\s*:/);
      if (nameMatch) {
        paramName = nameMatch[1];
        i += nameMatch[0].length - 1;
      }
    }
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

/** Extract method signatures from adapter source */
function extractMethods(content: string): MethodMeta[] {
  const methods: MethodMeta[] = [];
  const toolsMatch = content.match(/tools\s*:\s*\{/);
  if (!toolsMatch) return methods;

  const methodRegex = /(\w+)\s*:\s*\{[^}]*description\s*:\s*["']([^"']+)["']/g;
  let match;
  while ((match = methodRegex.exec(content)) !== null) {
    const methodName = match[1];
    const description = match[2];
    const paramsStart = content.indexOf("parameters:", match.index);
    const nextMethod = content.indexOf(`${methodName}:`, match.index + match[0].length);
    const params = paramsStart !== -1 && (nextMethod === -1 || paramsStart < nextMethod)
      ? parseParamsBlock(content, paramsStart + 11)
      : undefined;
    methods.push({ name: methodName, description, params });
  }

  return methods;
}

/** Extract adapter metadata from file without full import */
async function extractAdapterMetadata(filePath: string): Promise<{ name: string; description?: string; domain?: string; methods: MethodMeta[] } | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const nameMatch = content.match(/name\s*:\s*["']([^"']+)["']/);
    if (!nameMatch) return null;

    const descMatch = content.match(/description\s*:\s*["']([^"']+)["']/);
    const domainMatch = content.match(/domain\s*:\s*["']([^"']+)["']/);
    const methods = extractMethods(content);

    return {
      name: nameMatch[1],
      description: descMatch?.[1],
      domain: domainMatch?.[1],
      methods,
    };
  } catch {
    return null;
  }
}

/** Create a lazy adapter that loads full module on first method call */
function createLazyAdapter(metadata: { name: string; description?: string; domain?: string; methods: MethodMeta[] }, filePath: string): Adapter {
  const lazyTools: Record<string, AdapterMethod> = {};

  for (const method of metadata.methods) {
    lazyTools[method.name] = {
      description: method.description || `[Lazy] Method from ${metadata.name}`,
      parameters: method.params,
      execute: async (params: unknown) => {
        // Load full adapter on first call
        let fullAdapter = loadedAdapters.get(metadata.name);
        if (!fullAdapter) {
          console.error(pc.dim(`Lazy loading adapter: ${metadata.name}`));
          const module = await import(filePath);
          fullAdapter = module.default || module[metadata.name] || Object.values(module).find((v: unknown) => (v as Adapter)?.name === metadata.name) as Adapter;
          if (fullAdapter) {
            loadedAdapters.set(metadata.name, fullAdapter);
          }
        }

        if (!fullAdapter?.tools[method.name]) {
          throw new Error(`Method ${method.name} not found in ${metadata.name}`);
        }

        return fullAdapter.tools[method.name].execute(params);
      },
    };
  }

  return {
    name: metadata.name,
    description: metadata.description,
    domain: metadata.domain,
    tools: lazyTools,
    __lazy: true,
    __path: filePath,
  };
}

/**
 * Load adapters from ~/.mcx/adapters/ with lazy loading.
 * Only extracts metadata at startup, full module loads on first use.
 */
export async function loadAdaptersFromDir(): Promise<Adapter[]> {
  const adaptersDir = join(getMcxHomeDir(), "adapters");
  if (!existsSync(adaptersDir)) return [];

  const adapters: Adapter[] = [];
  const glob = new Bun.Glob("**/*.ts");

  for await (const path of glob.scan({ cwd: adaptersDir, onlyFiles: true })) {
    // Skip test files and index files
    if (path.includes(".test.") || path.includes(".spec.") || path === "index.ts") {
      continue;
    }

    const fullPath = join(adaptersDir, path);
    const metadata = await extractAdapterMetadata(fullPath);

    if (metadata && metadata.methods.length > 0) {
      adapters.push(createLazyAdapter(metadata, fullPath));
    }
  }

  if (adapters.length > 0) {
    console.error(pc.dim(`Scanned ${adapters.length} lazy adapter(s) from ~/.mcx/adapters/`));
  }

  return adapters;
}

/**
 * Generate a readable signature from parameter definitions
 */
export function formatSignature(
  methodName: string,
  params: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> | undefined
): string {
  if (!params || Object.keys(params).length === 0) {
    return `${methodName}()`;
  }
  const paramList = Object.entries(params)
    .map(([name, def]) => {
      const hasDefault = 'default' in def;
      const optional = def.required === false || hasDefault ? '?' : '';
      const defaultStr = hasDefault ? ` = ${JSON.stringify(def.default)}` : '';
      return `${name}${optional}: ${def.type}${defaultStr}`;
    })
    .join(', ');
  return `${methodName}({ ${paramList} })`;
}

/**
 * Validate parameters and return helpful error message if invalid
 */
export function validateParams(
  adapterName: string,
  methodName: string,
  params: unknown,
  paramDefs: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }> | undefined
): { valid: true; correctedParams?: Record<string, unknown> } | { valid: false; error: string } {
  // No param definitions = no validation
  if (!paramDefs || Object.keys(paramDefs).length === 0) {
    return { valid: true };
  }

  const providedParams = (params && typeof params === 'object' && !Array.isArray(params))
    ? params as Record<string, unknown>
    : {};
  const providedNames = new Set(Object.keys(providedParams));
  const errors: string[] = [];
  let correctedParams: Record<string, unknown> | null = null;

  // Build final params with defaults applied
  const finalParams: Record<string, unknown> = { ...providedParams };

  // Check required params and apply defaults
  for (const [name, def] of Object.entries(paramDefs)) {
    if (!providedNames.has(name)) {
      if ('default' in def) {
        // Apply default value
        finalParams[name] = def.default;
        correctedParams = correctedParams || {};
      } else if (def.required !== false) {
        errors.push(`missing required param '${name}'`);
      }
    }
  }

  // Check for unknown params
  for (const provided of providedNames) {
    if (!(provided in paramDefs)) {
      errors.push(`unknown param '${provided}'`);
    }
  }

  // Check types for params
  for (const [name, value] of Object.entries(finalParams)) {
    const def = paramDefs[name];
    if (!def) continue;

    const actualType = Array.isArray(value) ? 'array' : typeof value;
    const expectedType = def.type.toLowerCase();

    // Basic type checking (string, number, boolean, array, object)
    if (expectedType === 'string' && typeof value !== 'string') {
      errors.push(`'${name}' should be string, got ${actualType}`);
    } else if (expectedType === 'number' && typeof value !== 'number') {
      errors.push(`'${name}' should be number, got ${actualType}`);
    } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
      errors.push(`'${name}' should be boolean, got ${actualType}`);
    } else if (expectedType === 'array' && !Array.isArray(value)) {
      errors.push(`'${name}' should be array, got ${actualType}`);
    }
  }

  if (errors.length === 0) {
    // Return corrected params if any corrections were made
    return correctedParams
      ? { valid: true, correctedParams: finalParams }
      : { valid: true };
  }

  // Build helpful error message
  const signature = formatSignature(methodName, paramDefs);
  const msg = `${adapterName}.${methodName}: ${errors.join(', ')}\nExpected: ${signature}`;

  return { valid: false, error: msg };
}

/**
 * Build adapter context for sandbox execution
 */
export function buildAdapterContext(adapters: Adapter[]): Record<string, Record<string, (params: unknown) => Promise<unknown>>> {
  const ctx: Record<string, Record<string, (params: unknown) => Promise<unknown>>> = {};

  for (const adapter of adapters) {
    const methods: Record<string, (params: unknown) => Promise<unknown>> = {};
    for (const [methodName, method] of Object.entries(adapter.tools)) {
      // Wrap execute with parameter validation and auto-correction
      methods[methodName] = async (params: unknown) => {
        const validation = validateParams(adapter.name, methodName, params, method.parameters);
        if (!validation.valid) {
          throw new Error(validation.error);
        }
        // Use corrected params if auto-correction was applied
        const finalParams = validation.correctedParams ?? (params ?? {});
        return method.execute(finalParams as Record<string, unknown>);
      };
    }

    // Register under original name
    ctx[adapter.name] = methods;

    // Also register camelCase alias for kebab-case names (chrome-devtools -> chromeDevtools)
    if (adapter.name.includes('-')) {
      ctx[toCamelCase(adapter.name)] = methods;
    }
  }

  return ctx;
}

// ============================================================================
// MCP Server Factory
// ============================================================================

import { createMcxServerCore } from "./core.js";

/**
 * Create MCX MCP server with all adapters and skills loaded
 */
export async function createMcxServer(fffSearchPath?: string, disableFrecency?: boolean) {
  // Parallelize independent startup operations
  const [config, lazyAdapters, skills] = await Promise.all([
    loadConfig(),
    loadAdaptersFromDir(),
    loadSkills(),
  ]);

  const configAdapters = config?.adapters || [];

  // Merge adapters: config adapters take precedence over lazy adapters (by name)
  const configNames = new Set(configAdapters.map(a => a.name));
  const filteredLazyAdapters = lazyAdapters.filter(a => !configNames.has(a.name));
  const skippedCount = lazyAdapters.length - filteredLazyAdapters.length;
  const adapters = [...configAdapters, ...filteredLazyAdapters];

  // Clear message about what loaded
  const parts = [`${configAdapters.length} config`, `${filteredLazyAdapters.length} lazy`];
  if (skippedCount > 0) parts.push(`${skippedCount} skipped (in config)`);
  console.error(pc.dim(`Loaded ${parts.join(' + ')} adapter(s), ${skills.size} skill(s)`));
  
  return createMcxServerCore(config, adapters, skills, fffSearchPath, disableFrecency);
}
