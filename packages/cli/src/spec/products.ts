import type { AdapterSpec, ResolvedSpec } from './types.js';

/**
 * Extracts product/adapter names for tool description hints.
 * These help the LLM know what's available without reading full spec.
 */
export function extractProducts(spec: ResolvedSpec): string[] {
  return Object.keys(spec.adapters);
}

/**
 * Extracts tool names grouped by adapter.
 * Format: "adapter:toolName"
 */
export function extractToolNames(spec: ResolvedSpec): string[] {
  const tools: string[] = [];

  for (const [adapterName, adapter] of Object.entries(spec.adapters)) {
    for (const toolName of Object.keys(adapter.tools)) {
      tools.push(`${adapterName}:${toolName}`);
    }
  }

  return tools;
}

/**
 * Extracts a summary of endpoints for the tool description.
 * Groups by HTTP method for quick scanning.
 */
export function extractEndpointSummary(adapter: AdapterSpec): string {
  const byMethod: Record<string, string[]> = {};

  for (const tool of Object.values(adapter.tools)) {
    const method = tool.method.toUpperCase();
    if (!byMethod[method]) {
      byMethod[method] = [];
    }
    byMethod[method].push(tool.name);
  }

  return Object.entries(byMethod)
    .map(([method, names]) => `${method}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '...' : ''}`)
    .join(' | ');
}

/**
 * Generates a compact description for mcx_search tool.
 * Lists available adapters and sample tools.
 */
export function generateSpecDescription(spec: ResolvedSpec, maxTools = 20): string {
  const products = extractProducts(spec);
  const allTools = extractToolNames(spec);
  const toolsSample = allTools.slice(0, maxTools);

  return `Adapters: ${products.join(', ')}
Tools: ${toolsSample.join(', ')}${allTools.length > maxTools ? ` (+${allTools.length - maxTools} more)` : ''}`;
}
