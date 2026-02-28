import { pathToFileURL } from "node:url";
import { createSandbox } from "./sandbox/bun-worker.js";
import type { ISandbox } from "./sandbox/interface.js";
import type {
  Adapter,
  ExecutionContext,
  MCXConfig,
  SandboxConfig,
  SandboxResult,
  Skill,
} from "./types.js";

/**
 * Options for executor initialization.
 */
export interface ExecutorOptions {
  /** Path to the mcx.config.ts file */
  configPath?: string;
  /** Initial configuration (merged with loaded config) */
  config?: MCXConfig;
  /** Custom sandbox factory */
  sandboxFactory?: (config?: SandboxConfig) => ISandbox;
}

/**
 * Main MCX executor class.
 *
 * Manages adapters, skills, and code execution in a sandboxed environment.
 *
 * @example
 * ```ts
 * const executor = new MCXExecutor();
 * await executor.loadConfig('./mcx.config.ts');
 *
 * // Execute raw code
 * const result = await executor.execute(`
 *   const data = await adapters.file.read('input.txt');
 *   return data.toUpperCase();
 * `);
 *
 * // Run a registered skill
 * const skillResult = await executor.runSkill('process-data');
 * ```
 */
export class MCXExecutor {
  private adapters: Map<string, Adapter> = new Map();
  private skills: Map<string, Skill> = new Map();
  private sandboxConfig: SandboxConfig;
  private sandboxFactory: (config?: SandboxConfig) => ISandbox;
  private configPath?: string;

  constructor(options: ExecutorOptions = {}) {
    this.sandboxConfig = options.config?.sandbox ?? {
      timeout: 5000,
      memoryLimit: 128,
      allowAsync: true,
      globals: {},
    };
    this.sandboxFactory = options.sandboxFactory ?? createSandbox;
    this.configPath = options.configPath;

    // Register initial adapters and skills from config
    if (options.config?.adapters) {
      for (const adapter of options.config.adapters) {
        this.registerAdapter(adapter);
      }
    }
    if (options.config?.skills) {
      for (const skill of options.config.skills) {
        this.registerSkill(skill);
      }
    }
  }

  /**
   * Load configuration from an mcx.config.ts file.
   *
   * @param configPath - Path to the configuration file
   */
  async loadConfig(configPath?: string): Promise<void> {
    const path = configPath ?? this.configPath ?? "./mcx.config.ts";

    try {
      // Convert to file URL for proper ESM import
      const fileUrl = pathToFileURL(path).href;
      const module = await import(fileUrl);
      const config: MCXConfig = module.default ?? module;

      // Merge sandbox config
      if (config.sandbox) {
        this.sandboxConfig = {
          ...this.sandboxConfig,
          ...config.sandbox,
        };
      }

      // Register adapters
      if (config.adapters) {
        for (const adapter of config.adapters) {
          this.registerAdapter(adapter);
        }
      }

      // Register skills
      if (config.skills) {
        for (const skill of config.skills) {
          this.registerSkill(skill);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to load MCX config from ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Register an adapter.
   *
   * @param adapter - The adapter to register
   */
  registerAdapter(adapter: Adapter): void {
    if (this.adapters.has(adapter.name)) {
      console.warn(`Adapter "${adapter.name}" is being overwritten`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Unregister an adapter.
   *
   * @param name - The adapter name
   * @returns Whether the adapter was removed
   */
  unregisterAdapter(name: string): boolean {
    return this.adapters.delete(name);
  }

  /**
   * Get a registered adapter by name.
   *
   * @param name - The adapter name
   */
  getAdapter(name: string): Adapter | undefined {
    return this.adapters.get(name);
  }

  /**
   * Get all registered adapter names.
   */
  getAdapterNames(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Register a skill.
   *
   * @param skill - The skill to register
   */
  registerSkill(skill: Skill): void {
    if (this.skills.has(skill.name)) {
      console.warn(`Skill "${skill.name}" is being overwritten`);
    }
    this.skills.set(skill.name, skill);
  }

  /**
   * Unregister a skill.
   *
   * @param name - The skill name
   * @returns Whether the skill was removed
   */
  unregisterSkill(name: string): boolean {
    return this.skills.delete(name);
  }

  /**
   * Get a registered skill by name.
   *
   * @param name - The skill name
   */
  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get all registered skill names.
   */
  getSkillNames(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Execute code in the sandbox.
   *
   * @param code - The code to execute
   * @param options - Execution options
   */
  async execute<T = unknown>(
    code: string,
    options: {
      /** Override sandbox config for this execution */
      sandbox?: Partial<SandboxConfig>;
      /** Specific adapters to include (default: all) */
      adapters?: string[];
      /** Additional context variables */
      variables?: Record<string, unknown>;
    } = {}
  ): Promise<SandboxResult<T>> {
    const sandboxConfig = {
      ...this.sandboxConfig,
      ...options.sandbox,
    };

    const sandbox = this.sandboxFactory(sandboxConfig);

    try {
      const context = this.buildExecutionContext(
        options.adapters,
        options.variables
      );
      return await sandbox.execute<T>(code, context);
    } finally {
      sandbox.dispose();
    }
  }

  /**
   * Run a registered skill by name.
   *
   * @param name - The skill name
   * @param options - Execution options
   */
  async runSkill<T = unknown>(
    name: string,
    options: {
      /** Additional context variables */
      variables?: Record<string, unknown>;
    } = {}
  ): Promise<SandboxResult<T>> {
    const skill = this.skills.get(name);
    if (!skill) {
      return {
        success: false,
        error: {
          name: "SkillNotFoundError",
          message: `Skill "${name}" not found`,
        },
        logs: [],
        executionTime: 0,
      };
    }

    // Validate required adapters
    const missingAdapters = skill.adapters.filter(
      (adapterName) => !this.adapters.has(adapterName)
    );
    if (missingAdapters.length > 0) {
      return {
        success: false,
        error: {
          name: "MissingAdaptersError",
          message: `Skill "${name}" requires missing adapters: ${missingAdapters.join(", ")}`,
        },
        logs: [],
        executionTime: 0,
      };
    }

    // Handle run-based skills (native execution)
    if (skill.run) {
      const startTime = performance.now();
      try {
        const context = this.buildExecutionContext(
          skill.adapters.length > 0 ? skill.adapters : undefined,
          options.variables
        );
        // Pass adapters as top-level properties for convenience
        const result = await skill.run({
          ...context.adapters,
          ...context.variables,
        });
        return {
          success: true,
          value: result as T,
          logs: [],
          executionTime: performance.now() - startTime,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // Truncate stack to 5 lines to prevent context bloat
        const stack = err.stack ? err.stack.split("\n").slice(0, 5).join("\n") : undefined;
        return {
          success: false,
          error: {
            name: err.name,
            message: err.message,
            stack,
          },
          logs: [],
          executionTime: performance.now() - startTime,
        };
      }
    }

    // Handle code-based skills (sandbox execution)
    if (!skill.code) {
      return {
        success: false,
        error: {
          name: "InvalidSkillError",
          message: `Skill "${name}" has neither code nor run function`,
        },
        logs: [],
        executionTime: 0,
      };
    }

    return this.execute<T>(skill.code, {
      sandbox: skill.sandboxConfig,
      adapters: skill.adapters.length > 0 ? skill.adapters : undefined,
      variables: options.variables,
    });
  }

  /**
   * Update the default sandbox configuration.
   */
  configureSandbox(config: Partial<SandboxConfig>): void {
    this.sandboxConfig = {
      ...this.sandboxConfig,
      ...config,
    };
  }

  /**
   * Build the execution context for the sandbox.
   */
  private buildExecutionContext(
    adapterNames?: string[],
    variables?: Record<string, unknown>
  ): ExecutionContext {
    const adaptersToInclude = adapterNames
      ? adapterNames.filter((name) => this.adapters.has(name))
      : Array.from(this.adapters.keys());

    const adapterMethods: ExecutionContext["adapters"] = {};

    for (const name of adaptersToInclude) {
      const adapter = this.adapters.get(name);
      if (!adapter) continue;

      adapterMethods[name] = {};
      // Support both new (tools: Record) and legacy (methods: Map) adapters
      const tools = adapter.tools ?? (adapter as unknown as { methods: Map<string, { execute: (...args: unknown[]) => unknown }> }).methods;
      if (tools instanceof Map) {
        // Legacy adapter with methods: Map
        for (const [methodName, method] of tools) {
          adapterMethods[name][methodName] = method.execute.bind(method);
        }
      } else {
        // New adapter with tools: Record
        for (const [toolName, tool] of Object.entries(tools)) {
          adapterMethods[name][toolName] = tool.execute.bind(tool);
        }
      }
    }

    return {
      adapters: adapterMethods,
      variables,
    };
  }
}

/**
 * Create a new MCXExecutor instance.
 *
 * @example
 * ```ts
 * const executor = createExecutor({
 *   configPath: './mcx.config.ts',
 * });
 * await executor.loadConfig();
 * ```
 */
export function createExecutor(options?: ExecutorOptions): MCXExecutor {
  return new MCXExecutor(options);
}
