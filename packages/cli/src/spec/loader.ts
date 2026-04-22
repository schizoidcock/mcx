import type { AdapterSpec, ToolSpec, ParameterSpec, ResolvedSpec } from './types.js';
import { extractProducts } from './products.js';

/**
 * Infer likely source methods for ID parameters.
 * E.g., customer_id -> ['getCustomers', 'listCustomers', 'get_customers']
 */
function inferRequires(paramName: string): string[] | null {
  // Match patterns: customer_id, customerId, customer_uuid, customerUuid
  const match = paramName.match(/^(.+?)(?:_id|Id|_uuid|Uuid)$/);
  if (!match) return null;

  const entity = match[1];
  // Normalize: customer_name -> customerName, already camelCase stays same
  const camelEntity = entity.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const snakeEntity = entity.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');

  // Pluralize (simple: add 's', handle 'y' -> 'ies')
  const pluralize = (s: string) => s.endsWith('y') ? s.slice(0, -1) + 'ies' : s + 's';
  const camelPlural = pluralize(camelEntity);
  const snakePlural = pluralize(snakeEntity);

  return [
    `get${camelPlural.charAt(0).toUpperCase()}${camelPlural.slice(1)}`,  // getCustomers
    `list${camelPlural.charAt(0).toUpperCase()}${camelPlural.slice(1)}`, // listCustomers
    `get_${snakePlural}`,  // get_customers
    `list_${snakePlural}`, // list_customers
    `get${camelEntity.charAt(0).toUpperCase()}${camelEntity.slice(1)}`,  // getCustomer
    `get_${snakeEntity}`,  // get_customer
  ];
}

/**
 * MCX Adapter interface (from serve.ts)
 */
interface AdapterMethod {
  description: string;
  parameters?: Record<string, {
    type: string;
    description?: string;
    required?: boolean;
    default?: unknown;
    example?: unknown;
  }>;
  responseSchema?: Record<string, unknown>;
  execute: (params: unknown) => Promise<unknown>;
}

interface Adapter {
  name: string;
  description?: string;
  tools: Record<string, AdapterMethod>;
}

/**
 * Converts MCX adapters to ResolvedSpec format.
 * This provides a unified spec structure for mcx_search exploration.
 */
export function loadSpecsFromAdapters(adapters: Adapter[]): ResolvedSpec {
  const specs: Record<string, AdapterSpec> = {};

  for (const adapter of adapters) {
    const tools: Record<string, ToolSpec> = {};

    for (const [toolName, method] of Object.entries(adapter.tools)) {
      const parameters: ParameterSpec[] = [];

      if (method.parameters) {
        for (const [paramName, param] of Object.entries(method.parameters)) {
          parameters.push({
            name: paramName,
            type: param.type,
            description: param.description,
            required: param.required,
            default: param.default,
            example: param.example,
          });
        }
      }

      // Infer dependencies from ID parameters
      const requires: Record<string, string[]> = {};
      for (const param of parameters) {
        const sources = inferRequires(param.name);
        if (sources) {
          requires[param.name] = sources;
        }
      }

      tools[toolName] = {
        name: toolName,
        method: 'POST', // MCX adapters don't expose HTTP method
        path: `/${adapter.name}/${toolName}`,
        description: method.description,
        parameters,
        ...(Object.keys(requires).length > 0 && { requires }),
        ...(method.responseSchema && { responseSchema: method.responseSchema }),
      };
    }

    specs[adapter.name] = {
      name: adapter.name,
      description: adapter.description,
      tools,
    };
  }

  return {
    adapters: specs,
    products: extractProducts({ adapters: specs, products: [] }),
  };
}

/**
 * Case-insensitive lookup helper.
 */
function caseInsensitiveLookup<T>(
  obj: Record<string, T>,
  key: string
): T | undefined {
  if (obj[key]) return obj[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(obj)) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Gets spec for a single adapter by name.
 */
export function getAdapterSpec(
  spec: ResolvedSpec,
  adapterName: string
): AdapterSpec | undefined {
  return caseInsensitiveLookup(spec.adapters, adapterName);
}

/**
 * Gets a specific tool from an adapter.
 */
export function getToolSpec(
  spec: ResolvedSpec,
  adapterName: string,
  toolName: string
): ToolSpec | undefined {
  const adapter = getAdapterSpec(spec, adapterName);
  if (!adapter) return undefined;
  return caseInsensitiveLookup(adapter.tools, toolName);
}
