/**
 * mcx_adapter Tool
 * 
 * Unified adapter/skill discovery and execution.
 * Modes: list adapters, show methods, call method, run skill.
 */

import type { ToolContext, ToolDefinition, McpResult, AdapterSpec, SkillDef } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export interface AdapterParams {
  name?: string;
  call?: string;
  skill?: string;
  params?: Record<string, unknown>;
}

// ============================================================================
// Mode Handlers (each focused on one task)
// ============================================================================

function handleRunSkill(
  skills: Map<string, SkillDef>,
  skillName: string,
  params: Record<string, unknown> = {}
): McpResult {
  const skill = skills.get(skillName);
  if (!skill) {
    const available = Array.from(skills.keys()).join(", ") || "none";
    return formatError(`Skill "${skillName}" not found. Available: ${available}`);
  }
  
  // Build skill invocation
  const inputStr = Object.entries(params)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
  
  const output = [
    `Skill: ${skill.name}`,
    skill.description || "",
    "",
    `Invoke: ${skill.name}(${inputStr || ""})`,
  ];
  
  return formatToolResult(output.filter(Boolean).join("\n"));
}

function handleListAdapters(spec: AdapterSpec | null): McpResult {
  if (!spec?.adapters?.length) {
    return formatToolResult("No adapters loaded.\n→ mcx_doctor() to check config");
  }
  
  // Group by domain
  const byDomain = new Map<string, typeof spec.adapters>();
  for (const a of spec.adapters) {
    const domain = a.domain || "general";
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push(a);
  }
  
  const lines: string[] = [];
  for (const [domain, adapters] of byDomain) {
    const summary = adapters
      .map((a) => `${a.name}(${a.methods?.length || 0})`)
      .join(", ");
    lines.push(`[${domain}] ${summary}`);
  }
  
  lines.push("");
  lines.push("→ mcx_adapter({ name: \"adapter\" }) for methods");
  
  return formatToolResult(lines.join("\n"));
}

function handleShowMethods(
  spec: AdapterSpec,
  adapterName: string
): McpResult {
  const adapter = spec.adapters.find(
    (a) => a.name.toLowerCase() === adapterName.toLowerCase()
  );
  
  if (!adapter) {
    const names = spec.adapters.map((a) => a.name).join(", ");
    return formatError(`Adapter "${adapterName}" not found. Available: ${names}`);
  }
  
  const methods = adapter.methods || [];
  if (methods.length === 0) {
    return formatToolResult(`${adapter.name}: no methods`);
  }
  
  // Group by prefix
  const byPrefix = new Map<string, typeof methods>();
  for (const m of methods) {
    const prefix = m.name.split("_")[0] || "other";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(m);
  }
  
  const lines = [`## ${adapter.name}`, ""];
  for (const [prefix, group] of byPrefix) {
    lines.push(`### ${prefix}`);
    for (const m of group) {
      const params = m.parameters?.map((p) => p.name).join(", ") || "";
      lines.push(`- ${m.name}(${params})`);
    }
    lines.push("");
  }
  
  lines.push(`→ mcx_adapter({ name: "${adapter.name}", call: "method" })`);
  
  return formatToolResult(lines.join("\n"));
}

async function handleCallMethod(
  ctx: ToolContext,
  adapterName: string,
  methodName: string,
  params: Record<string, unknown> = {}
): Promise<McpResult> {
  if (!ctx.spec) {
    return formatError("No adapters loaded");
  }
  
  const adapter = ctx.spec.adapters.find(
    (a) => a.name.toLowerCase() === adapterName.toLowerCase()
  );
  
  if (!adapter) {
    return formatError(`Adapter "${adapterName}" not found`);
  }
  
  // Find method (fuzzy match)
  const method = adapter.methods?.find(
    (m) => m.name.toLowerCase() === methodName.toLowerCase() ||
           m.name.toLowerCase().includes(methodName.toLowerCase())
  );
  
  if (!method) {
    const names = adapter.methods?.map((m) => m.name).join(", ") || "none";
    return formatError(`Method "${methodName}" not found in ${adapter.name}. Available: ${names}`);
  }
  
  // Build call code
  const paramStr = JSON.stringify(params);
  const code = `await ${adapter.name}.${method.name}(${paramStr})`;
  
  try {
    const result = await ctx.sandbox.execute(code, {});
    const output = JSON.stringify(result.value, null, 2);
    return formatToolResult(`✓ ${adapter.name}.${method.name}\n\n${output.slice(0, 3000)}`);
  } catch (err) {
    return formatError(`${adapter.name}.${method.name} failed: ${String(err)}`);
  }
}

// ============================================================================
// Main Handler (dispatch only)
// ============================================================================

async function handleAdapter(
  ctx: ToolContext,
  params: AdapterParams,
  skills: Map<string, SkillDef>
): Promise<McpResult> {
  // Mode 4: Run skill
  if (params.skill) {
    return handleRunSkill(skills, params.skill, params.params);
  }
  
  // Mode 3: Call method
  if (params.name && params.call) {
    return handleCallMethod(ctx, params.name, params.call, params.params);
  }
  
  // Mode 2: Show methods
  if (params.name) {
    if (!ctx.spec) return formatError("No adapters loaded");
    return handleShowMethods(ctx.spec, params.name);
  }
  
  // Mode 1: List adapters
  return handleListAdapters(ctx.spec);
}

// ============================================================================
// Tool Definition
// ============================================================================

export function createAdapterTool(
  skills: Map<string, SkillDef>
): ToolDefinition<AdapterParams> {
  return {
    name: "mcx_adapter",
    description: `Adapter and skill discovery.

## Mode 1: List All Adapters & Skills
mcx_adapter() → grouped by domain: [auth] betterAuth(14), [db] supabase(25)

## Mode 2: Show Adapter Methods
mcx_adapter({ name: "supabase" }) → methods grouped by prefix

## Mode 3: Call Adapter Method
mcx_adapter({ name: "supabase", call: "list_projects" })

## Mode 4: Run Skill
mcx_adapter({ skill: "analyze", params: { target: "src/" } })`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Adapter name (omit to list all)" },
        call: { type: "string", description: "Method to call (requires name)" },
        skill: { type: "string", description: "Skill to run" },
        params: { type: "object", description: "Parameters for method/skill" },
      },
    },
    handler: (ctx, params) => handleAdapter(ctx, params, skills),
  };
}

export default createAdapterTool;
