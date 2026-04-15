/**
 * mcx_upgrade Tool
 * 
 * Get command to upgrade MCX to latest version.
 */

import type { ToolDefinition, McpResult } from "./types.js";


// ============================================================================
// Types
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface UpgradeParams {}

// ============================================================================
// Handler
// ============================================================================

async function handleUpgrade(): Promise<McpResult> {
  const pkg = await import("../../package.json");
  const currentVersion = pkg.version;
  const upgradeCmd = "bun add -g @papicandela/mcx-cli@latest";

  const output = [
    `Current: v${currentVersion}`,
    "",
    "To upgrade, run:",
    `  ${upgradeCmd}`,
    "",
    "Then restart your MCP session.",
  ];

  return output.join("\n");
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxUpgrade: ToolDefinition<UpgradeParams> = {
  name: "mcx_upgrade",
  description: "Get command to upgrade MCX to latest version.",
  inputSchema: { type: "object", properties: {} },
  handler: handleUpgrade,
};

export default mcxUpgrade;
