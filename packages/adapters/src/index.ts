/**
 * @mcx/adapters - Adapter utilities for the MCX framework
 *
 * This package provides:
 * - defineAdapter: Create custom adapters
 * - createFetchAdapter: Generic HTTP client
 * - generateAdapter: Generate adapters from OpenAPI specs
 *
 * @example
 * ```ts
 * import { defineAdapter, createFetchAdapter } from '@mcx/adapters';
 *
 * // Generic HTTP adapter
 * const api = createFetchAdapter({
 *   baseUrl: 'https://api.example.com',
 *   headers: { 'Authorization': `Bearer ${token}` },
 * });
 *
 * // Custom adapter
 * export const myAdapter = defineAdapter({
 *   name: 'my-api',
 *   tools: {
 *     getData: {
 *       description: 'Fetch data from API',
 *       parameters: { id: { type: 'string', required: true } },
 *       execute: async ({ id }) => {
 *         // implementation
 *       },
 *     },
 *   },
 * });
 * ```
 */

// Base adapter utilities
export {
  BaseAdapter,
  defineAdapter,
  BaseConfigSchema,
  type BaseConfig,
  type AdapterTool,
  type AdapterDefinition,
  type AdapterInstance,
  type AdapterContext,
  type ParameterDefinition,
} from "./base.js";

// HTTP fetch adapter
export {
  createFetchAdapter,
  fetchAdapter,
  FetchConfigSchema,
  type FetchConfig,
  type RequestOptions,
  type HttpResponse,
} from "./fetch.js";

// Adapter generator
export { generateAdapter } from "./generator.js";
