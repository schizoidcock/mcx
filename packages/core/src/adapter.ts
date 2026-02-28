import { z } from "zod";
import type {
  LegacyAdapter,
  AdapterConfig,
  AdapterMethod,
  AdapterMethodConfig,
  AdapterMethodParameter,
} from "./types.js";

/**
 * Schema for validating adapter method parameters at runtime.
 */
function createParameterValidator(
  params: AdapterMethodParameter[]
): z.ZodSchema {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const param of params) {
    let schema: z.ZodTypeAny;

    switch (param.type) {
      case "string":
        schema = z.string();
        break;
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "object":
        schema = z.record(z.unknown());
        break;
      case "array":
        schema = z.array(z.unknown());
        break;
      default:
        schema = z.unknown();
    }

    // IMPORTANT: Order matters in Zod!
    // .optional() must come BEFORE .default() so that:
    // - absent input resolves to the default (not undefined)
    // - z.string().optional().default("x") = ZodDefault<ZodOptional<...>>
    if (!param.required) {
      schema = schema.optional();
    }

    if (param.default !== undefined) {
      schema = schema.default(param.default);
    }

    shape[param.name] = schema;
  }

  return z.object(shape);
}

/**
 * Create a validated adapter method from configuration.
 */
function createMethod(config: AdapterMethodConfig): AdapterMethod {
  const parameters = config.parameters ?? [];
  const validator = createParameterValidator(parameters);

  const execute = async (...args: unknown[]): Promise<unknown> => {
    // Build parameter object from positional arguments
    const paramObj: Record<string, unknown> = {};
    parameters.forEach((param, index) => {
      if (index < args.length) {
        paramObj[param.name] = args[index];
      }
    });

    // Validate parameters
    const validatedParams = validator.parse(paramObj);

    // Convert back to positional arguments for handler
    const validatedArgs = parameters.map((param) => validatedParams[param.name]);

    return config.handler(...validatedArgs);
  };

  return {
    name: config.name,
    description: config.description,
    parameters,
    execute,
  };
}

/**
 * Define an adapter with type-safe configuration and zod validation.
 *
 * @deprecated Use defineAdapter from @papicandela/mcx-adapters instead.
 * This function creates legacy adapters with methods: Map<>.
 * The new unified Adapter type uses tools: Record<>.
 *
 * @example
 * ```ts
 * const fileAdapter = defineAdapter({
 *   name: 'file',
 *   description: 'File system operations',
 *   configSchema: z.object({
 *     basePath: z.string().default('./'),
 *   }),
 *   methods: [
 *     {
 *       name: 'read',
 *       parameters: [
 *         { name: 'path', type: 'string', required: true },
 *       ],
 *       handler: (path: string) => fs.readFileSync(path, 'utf-8'),
 *     },
 *   ],
 * });
 * ```
 */
export function defineAdapter<TSchema extends z.ZodTypeAny = z.ZodTypeAny>(
  config: AdapterConfig<TSchema>,
  adapterConfig?: z.infer<TSchema>
): LegacyAdapter {
  // Validate adapter configuration if schema provided
  let validatedConfig: unknown;
  if (config.configSchema && adapterConfig !== undefined) {
    validatedConfig = config.configSchema.parse(adapterConfig);
  } else {
    validatedConfig = adapterConfig;
  }

  // Create methods map
  const methods = new Map<string, AdapterMethod>();
  for (const methodConfig of config.methods) {
    const method = createMethod(methodConfig);
    methods.set(method.name, method);
  }

  return {
    name: config.name,
    description: config.description,
    version: config.version ?? "1.0.0",
    methods,
    config: validatedConfig,
  };
}

/**
 * Type helper for creating strongly-typed adapter configurations.
 */
export type InferAdapterConfig<T extends AdapterConfig> = T extends AdapterConfig<
  infer TSchema
>
  ? z.infer<TSchema>
  : never;

/**
 * Create an adapter factory that can be configured later.
 *
 * @deprecated Use defineAdapter from @papicandela/mcx-adapters instead.
 *
 * @example
 * ```ts
 * const createFileAdapter = createAdapterFactory({
 *   name: 'file',
 *   configSchema: z.object({ basePath: z.string() }),
 *   methods: [...],
 * });
 *
 * const adapter = createFileAdapter({ basePath: '/data' });
 * ```
 */
export function createAdapterFactory<TSchema extends z.ZodTypeAny>(
  config: AdapterConfig<TSchema>
): (adapterConfig: z.infer<TSchema>) => LegacyAdapter {
  return (adapterConfig: z.infer<TSchema>) => defineAdapter(config, adapterConfig);
}
