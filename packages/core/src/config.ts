import type { Adapter, MCXConfig, SandboxConfig, Skill } from "./types.js";
import { DEFAULT_NETWORK_POLICY } from "./sandbox/network-policy.js";
import { DEFAULT_ANALYSIS_CONFIG } from "./sandbox/analyzer/index.js";

/**
 * Default MCX configuration values.
 * Must include all sandbox fields to ensure network isolation is always enabled.
 */
const DEFAULT_CONFIG: Required<Omit<MCXConfig, "adapters" | "skills" | "env">> = {
  sandbox: {
    timeout: 5000,
    memoryLimit: 128,
    allowAsync: true,
    globals: {},
    networkPolicy: DEFAULT_NETWORK_POLICY,
    normalizeCode: true,
    analysis: DEFAULT_ANALYSIS_CONFIG,
  },
  adaptersDir: "./adapters",
  skillsDir: "./skills",
};

/**
 * Define the MCX framework configuration.
 *
 * This is typically used in an `mcx.config.ts` file at the root of your project.
 *
 * @example
 * ```ts
 * // mcx.config.ts
 * import { defineConfig } from '@mcx/core';
 * import { fileAdapter } from './adapters/file';
 * import { httpAdapter } from './adapters/http';
 *
 * export default defineConfig({
 *   adapters: [fileAdapter, httpAdapter],
 *   skills: [],
 *   sandbox: {
 *     timeout: 10000,
 *     memoryLimit: 256,
 *   },
 * });
 * ```
 */
export function defineConfig(config: MCXConfig): MCXConfig {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    sandbox: {
      ...DEFAULT_CONFIG.sandbox,
      ...config.sandbox,
    },
  };
}

/**
 * Configuration builder for fluent MCX configuration.
 *
 * @example
 * ```ts
 * const config = configBuilder()
 *   .adapter(fileAdapter)
 *   .adapter(httpAdapter)
 *   .skill(processSkill)
 *   .sandbox({ timeout: 10000 })
 *   .build();
 * ```
 */
export function configBuilder(): MCXConfigBuilder {
  return new MCXConfigBuilder();
}

/**
 * Fluent builder for MCX configuration.
 */
class MCXConfigBuilder {
  private config: MCXConfig = {
    adapters: [],
    skills: [],
  };

  /**
   * Add an adapter to the configuration.
   */
  adapter(adapter: Adapter): this {
    this.config.adapters = [...(this.config.adapters ?? []), adapter];
    return this;
  }

  /**
   * Add multiple adapters to the configuration.
   */
  adapters(...adapters: Adapter[]): this {
    this.config.adapters = [...(this.config.adapters ?? []), ...adapters];
    return this;
  }

  /**
   * Add a skill to the configuration.
   */
  skill(skill: Skill): this {
    this.config.skills = [...(this.config.skills ?? []), skill];
    return this;
  }

  /**
   * Add multiple skills to the configuration.
   */
  skills(...skills: Skill[]): this {
    this.config.skills = [...(this.config.skills ?? []), ...skills];
    return this;
  }

  /**
   * Set the sandbox configuration.
   */
  sandbox(config: SandboxConfig): this {
    this.config.sandbox = {
      ...this.config.sandbox,
      ...config,
    };
    return this;
  }

  /**
   * Set the adapters directory path.
   */
  adaptersDir(path: string): this {
    this.config.adaptersDir = path;
    return this;
  }

  /**
   * Set the skills directory path.
   */
  skillsDir(path: string): this {
    this.config.skillsDir = path;
    return this;
  }

  /**
   * Build the configuration.
   */
  build(): MCXConfig {
    return defineConfig(this.config);
  }
}

/**
 * Merge multiple configurations together.
 * Later configurations override earlier ones.
 */
export function mergeConfigs(...configs: MCXConfig[]): MCXConfig {
  const merged: MCXConfig = {
    adapters: [],
    skills: [],
    sandbox: { ...DEFAULT_CONFIG.sandbox },
    adaptersDir: DEFAULT_CONFIG.adaptersDir,
    skillsDir: DEFAULT_CONFIG.skillsDir,
  };

  for (const config of configs) {
    if (config.adapters) {
      merged.adapters = [...(merged.adapters ?? []), ...config.adapters];
    }
    if (config.skills) {
      merged.skills = [...(merged.skills ?? []), ...config.skills];
    }
    if (config.sandbox) {
      merged.sandbox = { ...merged.sandbox, ...config.sandbox };
    }
    if (config.adaptersDir) {
      merged.adaptersDir = config.adaptersDir;
    }
    if (config.skillsDir) {
      merged.skillsDir = config.skillsDir;
    }
  }

  return merged;
}
