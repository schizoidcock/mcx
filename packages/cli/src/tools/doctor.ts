/**
 * mcx_doctor Tool
 * 
 * Run diagnostics to check MCX health.
 * Checks runtime, database, adapters, sandbox.
 */

import { BunWorkerSandbox } from "@papicandela/mcx-core";
import type { ToolContext, ToolDefinition, McpResult } from "./types.js";
import { formatToolResult } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

interface DiagnosticCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface DoctorParams {}

// ============================================================================
// Handler
// ============================================================================

async function handleDoctor(
  ctx: ToolContext,
  _params: DoctorParams
): Promise<McpResult> {
  const checks: DiagnosticCheck[] = [];

  // 1. Bun runtime
  try {
    const bunVersion = Bun.version;
    checks.push({ name: "Bun runtime", status: "pass", detail: `v${bunVersion}` });
  } catch {
    checks.push({ name: "Bun runtime", status: "fail", detail: "Not available" });
  }

  // 2. SQLite/FTS5
  try {
    const sources = ctx.contentStore.getSources();
    checks.push({ 
      name: "SQLite/FTS5", 
      status: "pass", 
      detail: `${sources.length} sources indexed` 
    });
  } catch (e) {
    checks.push({ name: "SQLite/FTS5", status: "fail", detail: String(e) });
  }

  // 3. Adapters loaded
  const adapterCount = ctx.spec?.adapters 
    ? Object.keys(ctx.spec.adapters).length 
    : 0;
  
  if (adapterCount > 0) {
    checks.push({ 
      name: "Adapters", 
      status: "pass", 
      detail: `${adapterCount} loaded` 
    });
  } else {
    checks.push({ name: "Adapters", status: "warn", detail: "None loaded" });
  }

  // 4. Sandbox test
  try {
    const testSandbox = new BunWorkerSandbox({ timeout: 1000 });
    const result = await testSandbox.execute<number>("1 + 1", { adapters: {} });
    
    if (result.success && result.value === 2) {
      checks.push({ name: "Sandbox", status: "pass", detail: "Execution OK" });
    } else if (result.success) {
      checks.push({ 
        name: "Sandbox", 
        status: "warn", 
        detail: `Unexpected: ${JSON.stringify(result.value)}` 
      });
    } else {
      checks.push({ 
        name: "Sandbox", 
        status: "fail", 
        detail: result.error?.message || "Unknown error" 
      });
    }
  } catch (e) {
    checks.push({ name: "Sandbox", status: "fail", detail: String(e) });
  }

  // 5. FFF (optional)
  if (ctx.finder) {
    checks.push({ name: "FFF", status: "pass", detail: "Initialized" });
  } else {
    checks.push({ name: "FFF", status: "warn", detail: "Not initialized (lazy)" });
  }

  // 6. MCX version
  try {
    const pkg = await import("../../package.json");
    checks.push({ name: "Version", status: "pass", detail: `v${pkg.version}` });
  } catch {
    checks.push({ name: "Version", status: "warn", detail: "Unknown" });
  }

  // 7. Worker pool status
  if (ctx.sandbox && typeof (ctx.sandbox as any).getPoolStats === "function") {
    try {
      const stats = (ctx.sandbox as any).getPoolStats();
      checks.push({ 
        name: "Worker Pool", 
        status: "pass", 
        detail: `${stats.idle}/${stats.total} workers idle` 
      });
    } catch {
      checks.push({ name: "Worker Pool", status: "warn", detail: "Stats unavailable" });
    }
  }

  // Format output
  const icon = (s: "pass" | "warn" | "fail") => 
    s === "pass" ? "[x]" : s === "warn" ? "[~]" : "[ ]";
  
  const passCount = checks.filter(c => c.status === "pass").length;
  
  const output = [
    "MCX Diagnostics",
    "───────────────",
    ...checks.map(c => `${icon(c.status)} ${c.name}: ${c.detail}`),
    "",
    `${passCount}/${checks.length} checks passed`,
  ];

  return formatToolResult(output.join("\n"));
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxDoctor: ToolDefinition<DoctorParams> = {
  name: "mcx_doctor",
  description: "Run diagnostics to check MCX configuration, FFF status, and adapter health.",
  inputSchema: { type: "object", properties: {} },
  handler: handleDoctor,
};

export default mcxDoctor;
