/**
 * mcx_adapter Tool
 * 
 * Unified adapter/skill discovery and execution.
 * Modes: list adapters, show methods, call method, run skill.
 */

import type { ToolContext, ToolDefinition, McpResult, SkillDef } from "./types.js";
import type { ResolvedSpec, } from "../spec/types.js";
import { formatError } from "./utils.js";
import { validationErrors } from "../context/messages/index.js";
import { setVariable, getAllPrefixed } from "../context/variables.js";
import { extractImages } from "../utils/images.js";
import { maybeToTOON, maybeObjectToTOON } from "../utils/truncate.js";
import { getContentStore } from "../context/store.js";
import { ADAPTER_TRUNCATE_THRESHOLD, ADAPTER_DISPLAY_LIMIT } from "./constants.js";
import { debugAdapter as debug } from "../utils/debug.js";

// ============================================================================
// Helpers
// ============================================================================

/** Convert kebab-case to camelCase for JS variable names */
function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Format successful adapter result with image extraction */
function formatAdapterSuccess(
  adapterName: string,
  methodName: string,
  resultValue: unknown
): McpResult {
  const { value, images } = extractImages(resultValue);
  const jsonStr = JSON.stringify(value, null, 2) ?? '(no output)';
  const output = maybeToTOON(value) ?? (typeof value === 'object' && value !== null && !Array.isArray(value) ? maybeObjectToTOON(value as Record<string, unknown>, 'result') : jsonStr);
  const truncated = jsonStr.length > ADAPTER_TRUNCATE_THRESHOLD;
  let displayed = output;
  let indexNote = '';
  
  if (truncated) {
    setVariable('_adapterResult', value);
    const label = adapterName + '.' + methodName;
    const store = getContentStore();
    store.index(jsonStr, label, { contentType: 'plaintext' });
    displayed = output.slice(0, ADAPTER_DISPLAY_LIMIT) + '\n...';
    indexNote = '\n📦 Indexed as "' + label + '". Use mcx_search({ queries: [...], source: "' + label + '" })';
  }
  
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text: '✓ ' + adapterName + '.' + methodName + '\n\n' + displayed + indexNote }
  ];
  for (const img of images) {
    content.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  
  return {
    content,
    _meta: truncated ? { truncated: true, storedAs: '_adapterResult' } : undefined,
  };
}

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
    return formatError(validationErrors.notFoundWithAvailable("Skill", skillName, available.split(", ")));
  }
  
  // Build skill invocation
  const inputStr = Object.entries(params || {})
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
  
  const output = [
    `Skill: ${skill.name}`,
    skill.description || "",
    "",
    `Invoke: ${skill.name}(${inputStr || ""})`,
  ];
  
  return output.filter(Boolean).join("\n");
}

function handleListAdapters(spec: ResolvedSpec | null): McpResult {
  const adapterList = spec?.adapters ? Object.values(spec.adapters) : [];
  if (!adapterList.length) {
    return "No adapters loaded.\n-> mcx_doctor() to check config";
  }
  
  const lines: string[] = [];
  for (const a of adapterList) {
    const toolCount = Object.keys(a.tools || {}).length;
    lines.push(`- ${a.name} (${toolCount} methods)`);
  }
  
  lines.push("");
  lines.push("-> mcx_adapter({ name: \"adapter\" }) for methods");
  
  return lines.join("\n");
}

function handleShowMethods(
  spec: ResolvedSpec,
  adapterName: string
): McpResult {
  const adapterList = Object.values(spec.adapters);
  const adapter = adapterList.find(
    (a) => a.name.toLowerCase() === adapterName.toLowerCase()
  );
  
  if (!adapter) {
    const names = adapterList.map((a) => a.name).join(", ");
    return formatError(validationErrors.notFoundWithAvailable("Adapter", adapterName, names.split(", ")));
  }
  
  const methods = Object.values(adapter.tools || {});
  if (methods.length === 0) {
    return `${adapter.name}: no methods`;
  }
  
  // Group by prefix
  const byPrefix = new Map<string, typeof methods>();
  for (const m of methods) {
    const prefix = m.name.split("_")[0] || "other";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)?.push(m);
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
  
  lines.push(`-> mcx_adapter({ name: "${adapter.name}", call: "method" })`);
  
  return lines.join("\n");
}

async function handleCallMethod(
  ctx: ToolContext,
  adapterName: string,
  methodName: string,
  params: Record<string, unknown> = {}
): Promise<McpResult> {
  const spec = ctx.spec as ResolvedSpec | null;
  if (!spec) {
    return formatError(validationErrors.noAdaptersLoaded());
  }
  
  const adapterList = Object.values(spec.adapters);
  const adapter = adapterList.find(
    (a) => a.name.toLowerCase() === adapterName.toLowerCase()
  );
  
  if (!adapter) {
    return formatError(validationErrors.notFound("Adapter", adapterName));
  }
  
  // Find method (fuzzy match)
  const methods = Object.values(adapter.tools || {});
  const method = methods.find(
    (m) => m.name.toLowerCase() === methodName.toLowerCase() ||
           m.name.toLowerCase().includes(methodName.toLowerCase())
  );
  
  if (!method) {
    const names = methods.map((m) => m.name).join(", ") || "none";
    return formatError(validationErrors.methodNotFound(methodName, adapter.name, names.split(", ")));
  }
  
  // Build call code (convert kebab-case to camelCase for JS)
  const paramStr = JSON.stringify(params);
  const adapterVar = toCamelCase(adapter.name);
  const code = `await ${adapterVar}.${method.name}(${paramStr})`;
  
  try {
    const result = await ctx.sandbox.execute(code, {
      adapters: ctx.adapterContext,
      variables: getAllPrefixed(),
      env: {},
    });
    
    if (!result.success) {
      return formatError(`${adapter.name}.${method.name} failed: ${result.error?.message || 'Unknown error'}`);
    }
    return formatAdapterSuccess(adapter.name, method.name, result.value);
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
  const span = debug.span("handleAdapter", { skill: params.skill, name: params.name, call: params.call });
  // Mode 4: Run skill
  if (params.skill) {
    span.end({ mode: "skill" });
    return handleRunSkill(skills, params.skill, params.params);
  }
  
  // Mode 3: Call method
  if (params.name && params.call) {
    span.end({ mode: "call" });
    return handleCallMethod(ctx, params.name, params.call, params.params);
  }
  
  // Mode 2: Show methods
  if (params.name) {
    const spec = ctx.spec as ResolvedSpec | null;
    if (!spec) { span.end({ error: "no spec" }); return formatError(validationErrors.noAdaptersLoaded()); }
    span.end({ mode: "methods" });
    return handleShowMethods(spec, params.name);
  }
  
  // Mode 1: List adapters
  span.end({ mode: "list" });
  return handleListAdapters(ctx.spec as ResolvedSpec | null);
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
mcx_adapter() -> grouped by domain: [auth] betterAuth(14), [db] supabase(25)

## Mode 2: Show Adapter Methods
mcx_adapter({ name: "supabase" }) -> methods grouped by prefix

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
        truncate: { type: "boolean", default: true, description: "Truncate large results" },
        maxItems: { type: "number", minimum: 1, maximum: 1000, default: 10, description: "Max array items" },
        maxStringLength: { type: "number", minimum: 10, maximum: 10000, default: 500, description: "Max string length" },
      },
    },
    handler: (ctx, params) => handleAdapter(ctx, params, skills),
  };
}

export default createAdapterTool;
