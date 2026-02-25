import { z } from "zod";

/**
 * Base configuration schema for all adapters
 */
export const BaseConfigSchema = z.object({
  /** Optional name override */
  name: z.string().optional(),
  /** Enable debug logging */
  debug: z.boolean().optional().default(false),
});

export type BaseConfig = z.infer<typeof BaseConfigSchema>;

/**
 * Adapter tool definition
 */
export interface AdapterTool<TParams = unknown, TResult = unknown> {
  description: string;
  parameters?: Record<string, ParameterDefinition>;
  // Note: The `any` union allows TypeScript to accept concrete parameter types
  // when AdapterTool is used without explicit generics (e.g., Record<string, AdapterTool>).
  // Runtime validation is done via Zod schemas in the parameters definition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (params: TParams | any) => Promise<TResult> | TResult;
}

/**
 * Parameter definition for adapter tools
 */
export interface ParameterDefinition {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
  default?: unknown;
}

/**
 * Adapter definition structure
 */
export interface AdapterDefinition<
  TConfig extends z.ZodTypeAny = typeof BaseConfigSchema,
  TTools extends Record<string, AdapterTool> = Record<string, AdapterTool>,
> {
  name: string;
  description?: string;
  version?: string;
  config?: TConfig;
  tools: TTools;
}

/**
 * Adapter instance with initialized tools
 */
export interface AdapterInstance<TTools extends Record<string, AdapterTool>> {
  name: string;
  description?: string;
  version: string;
  tools: TTools;
  dispose?: () => Promise<void> | void;
}

/**
 * Context provided to adapter methods during execution
 */
export interface AdapterContext<TConfig = unknown> {
  config: TConfig;
  debug: (message: string, ...args: unknown[]) => void;
}

/**
 * Abstract base class for creating adapters
 *
 * @example
 * ```ts
 * class MyAdapter extends BaseAdapter<typeof MyConfigSchema> {
 *   readonly name = "my-adapter";
 *   readonly description = "My custom adapter";
 *
 *   protected async initialize(): Promise<void> {
 *     // Setup client connections
 *   }
 *
 *   protected registerTools(): Record<string, AdapterTool> {
 *     return {
 *       myMethod: {
 *         description: "Does something",
 *         parameters: { input: { type: "string" } },
 *         execute: async ({ input }) => {
 *           return this.doSomething(input);
 *         },
 *       },
 *     };
 *   }
 * }
 * ```
 */
export abstract class BaseAdapter<
  TConfig extends z.ZodTypeAny = typeof BaseConfigSchema,
> {
  abstract readonly name: string;
  abstract readonly description?: string;
  readonly version: string = "0.1.0";

  protected config: z.infer<TConfig> | undefined;
  protected initialized = false;

  constructor(config?: z.infer<TConfig>) {
    this.config = config;
  }

  /**
   * Initialize the adapter with configuration
   */
  async init(config?: z.infer<TConfig>): Promise<this> {
    if (config) {
      this.config = config;
    }
    await this.initialize();
    this.initialized = true;
    return this;
  }

  /**
   * Override to perform async initialization
   */
  protected async initialize(): Promise<void> {
    // Default: no-op
  }

  /**
   * Override to register adapter tools
   */
  protected abstract registerTools(): Record<string, AdapterTool>;

  /**
   * Get all registered tools
   */
  getTools(): Record<string, AdapterTool> {
    return this.registerTools();
  }

  /**
   * Log debug message if debug mode is enabled
   */
  protected debug(message: string, ...args: unknown[]): void {
    if (this.config && "debug" in this.config && this.config.debug) {
      console.log(`[${this.name}] ${message}`, ...args);
    }
  }

  /**
   * Cleanup adapter resources
   */
  async dispose(): Promise<void> {
    // Default: no-op
  }

  /**
   * Convert to adapter instance
   */
  toInstance(): AdapterInstance<Record<string, AdapterTool>> {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      tools: this.getTools(),
      dispose: () => this.dispose(),
    };
  }
}

/**
 * Define an adapter using a declarative configuration
 *
 * @example
 * ```ts
 * export const myAdapter = defineAdapter({
 *   name: "my-adapter",
 *   description: "My custom adapter",
 *   config: z.object({ apiKey: z.string() }),
 *   tools: {
 *     getData: {
 *       description: "Get data from API",
 *       parameters: { id: { type: "string" } },
 *       execute: async ({ id }) => {
 *         // Implementation
 *       },
 *     },
 *   },
 * });
 * ```
 */
export function defineAdapter<
  TConfig extends z.ZodTypeAny,
  TTools extends Record<string, AdapterTool>,
>(definition: AdapterDefinition<TConfig, TTools>): AdapterDefinition<TConfig, TTools> {
  return {
    ...definition,
    version: definition.version ?? "0.1.0",
  };
}
