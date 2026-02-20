/**
 * MCX Configuration Template
 *
 * Copy this file to mcx.config.ts and customize:
 *   cp mcx.config.template.ts mcx.config.ts
 */
import { defineConfig } from "@mcx/core";

// Import your adapters here
// import { myAdapter } from './adapters/my-adapter';

export default defineConfig({
  /**
   * List of adapters to load
   */
  adapters: [
    // myAdapter,
  ],

  /**
   * Sandbox configuration (optional)
   */
  sandbox: {
    timeout: 5000,
    memoryLimit: 128,
  },
});
