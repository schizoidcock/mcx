/**
 * Sandbox Constants
 *
 * Centralized constants for sandbox configuration.
 * Linus principles: simple values, no complex types here.
 */

/** Memory warning threshold in MB */
export const MEMORY_WARNING_THRESHOLD = 256;

/** Worker pool configuration */
export const DEFAULT_POOL_CONFIG = {
  enabled: true,
  maxWorkers: 4,
};
