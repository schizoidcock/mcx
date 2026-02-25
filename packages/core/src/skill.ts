import type { SandboxConfig, Skill, SkillConfig } from "./types.js";
import { DEFAULT_NETWORK_POLICY } from "./sandbox/network-policy.js";
import { DEFAULT_ANALYSIS_CONFIG } from "./sandbox/analyzer/index.js";

/**
 * Default sandbox configuration for skills.
 */
const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
  timeout: 5000,
  memoryLimit: 128,
  allowAsync: true,
  globals: {},
  networkPolicy: DEFAULT_NETWORK_POLICY,
  normalizeCode: true,
  analysis: DEFAULT_ANALYSIS_CONFIG,
};

/**
 * Define a skill with configuration.
 *
 * Skills are executable code snippets that run in a sandboxed environment
 * with access to registered adapters.
 *
 * @example
 * ```ts
 * const mySkill = defineSkill({
 *   name: 'process-data',
 *   description: 'Processes data using file and http adapters',
 *   adapters: ['file', 'http'],
 *   code: `
 *     const data = await adapters.file.read('input.json');
 *     const result = await adapters.http.post('/api/process', { body: data });
 *     return result;
 *   `,
 *   sandbox: {
 *     timeout: 10000,
 *   },
 * });
 * ```
 */
export function defineSkill(config: SkillConfig): Skill {
  if (!config.name) {
    throw new Error("Skill name is required");
  }

  const hasCode = config.code && config.code.trim() !== "";
  const hasRun = typeof config.run === "function";

  if (!hasCode && !hasRun) {
    throw new Error("Skill must have either 'code' (string) or 'run' (function)");
  }

  return {
    name: config.name,
    description: config.description,
    version: config.version ?? "1.0.0",
    adapters: config.adapters ?? [],
    code: config.code,
    run: config.run,
    sandboxConfig: {
      ...DEFAULT_SANDBOX_CONFIG,
      ...config.sandbox,
    },
  };
}

/**
 * Define multiple skills at once.
 *
 * @example
 * ```ts
 * const skills = defineSkills([
 *   { name: 'skill1', code: '...' },
 *   { name: 'skill2', code: '...' },
 * ]);
 * ```
 */
export function defineSkills(configs: SkillConfig[]): Skill[] {
  return configs.map(defineSkill);
}

/**
 * Create a skill builder for fluent skill definition.
 *
 * @example
 * ```ts
 * const skill = skillBuilder('my-skill')
 *   .description('Does something useful')
 *   .requires('file', 'http')
 *   .timeout(10000)
 *   .code(`
 *     // skill code here
 *   `)
 *   .build();
 * ```
 */
export function skillBuilder(name: string): SkillBuilder {
  return new SkillBuilder(name);
}

/**
 * Fluent builder for skill configuration.
 */
class SkillBuilder {
  private config: SkillConfig;

  constructor(name: string) {
    this.config = {
      name,
      code: "",
    };
  }

  /**
   * Set the skill description.
   */
  description(description: string): this {
    this.config.description = description;
    return this;
  }

  /**
   * Set the skill version.
   */
  version(version: string): this {
    this.config.version = version;
    return this;
  }

  /**
   * Specify required adapters.
   */
  requires(...adapters: string[]): this {
    this.config.adapters = adapters;
    return this;
  }

  /**
   * Set the execution timeout in milliseconds.
   */
  timeout(ms: number): this {
    this.config.sandbox = {
      ...this.config.sandbox,
      timeout: ms,
    };
    return this;
  }

  /**
   * Set the memory limit in MB.
   */
  memoryLimit(mb: number): this {
    this.config.sandbox = {
      ...this.config.sandbox,
      memoryLimit: mb,
    };
    return this;
  }

  /**
   * Set the skill code.
   */
  code(code: string): this {
    this.config.code = code;
    return this;
  }

  /**
   * Set custom sandbox configuration.
   */
  sandbox(config: SandboxConfig): this {
    this.config.sandbox = {
      ...this.config.sandbox,
      ...config,
    };
    return this;
  }

  /**
   * Build the skill.
   */
  build(): Skill {
    return defineSkill(this.config);
  }
}
