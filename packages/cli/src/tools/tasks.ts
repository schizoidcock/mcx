/**
 * mcx_tasks Tool
 * 
 * Background task execution and management.
 * Modes: spawn, check, commands, operations.
 */

import type { ToolContext, ToolDefinition, McpResult, BackgroundTask } from "./types.js";
import { formatToolResult, formatError } from "./utils.js";

// ============================================================================
// Types
// ============================================================================

export interface TasksParams {
  // Spawn mode
  code?: string;
  label?: string;
  // Check mode
  id?: string;
  status?: "all" | "running" | "completed" | "failed";
  // Commands mode (shell)
  commands?: Array<{ label: string; command: string }>;
  // Operations mode (code)
  operations?: Array<{ code: string; storeAs?: string }>;
}

const MAX_TASKS = 20;

// ============================================================================
// Task Lifecycle (short, focused functions)
// ============================================================================

function generateTaskId(label?: string): string {
  const base = label || `task-${Date.now()}`;
  return base.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function createTask(id: string, label?: string): BackgroundTask {
  return {
    id,
    label,
    status: "running",
    startedAt: Date.now(),
    logs: [],
  };
}

function completeTask(task: BackgroundTask, result: unknown): void {
  task.status = "completed";
  task.completedAt = Date.now();
  task.result = result;
}

function failTask(task: BackgroundTask, error: string): void {
  task.status = "failed";
  task.completedAt = Date.now();
  task.error = error;
}

function formatDuration(task: BackgroundTask): string {
  const elapsed = (task.completedAt || Date.now()) - task.startedAt;
  return `${(elapsed / 1000).toFixed(1)}s`;
}

function cleanupOldTasks(tasks: Map<string, BackgroundTask>): void {
  if (tasks.size <= MAX_TASKS) return;
  
  const completed = [...tasks.entries()]
    .filter(([, t]) => t.status !== "running")
    .sort((a, b) => (a[1].completedAt || 0) - (b[1].completedAt || 0));
  
  while (tasks.size > MAX_TASKS && completed.length > 0) {
    const [id] = completed.shift()!;
    tasks.delete(id);
  }
}

// ============================================================================
// Mode Handlers (each ~15 lines, max 2 levels indentation)
// ============================================================================

async function handleSpawn(
  ctx: ToolContext,
  code: string,
  label?: string
): Promise<McpResult> {
  const taskId = generateTaskId(label);
  const existing = ctx.backgroundTasks.get(taskId);
  
  if (existing?.status === "running") {
    return formatError(`Task "${taskId}" already running`);
  }
  
  const task = createTask(taskId, label);
  ctx.backgroundTasks.set(taskId, task);
  cleanupOldTasks(ctx.backgroundTasks);
  
  // Fire and forget - execute in background
  ctx.sandbox.execute(code, {}).then(
    (result) => completeTask(task, result.value),
    (error) => failTask(task, String(error))
  );
  
  return formatToolResult(`Spawned task: ${taskId}\n→ mcx_tasks({ id: "${taskId}" }) to check status`);
}

function handleCheckById(
  tasks: Map<string, BackgroundTask>,
  id: string
): McpResult {
  const task = tasks.get(id);
  if (!task) return formatError(`Task "${id}" not found`);
  
  const lines = [
    `Task: ${task.id}`,
    `Status: ${task.status}`,
    `Duration: ${formatDuration(task)}`,
  ];
  
  if (task.result !== undefined) lines.push(`Result: ${JSON.stringify(task.result)}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.logs.length) lines.push(`Logs:\n${task.logs.join("\n")}`);
  
  return formatToolResult(lines.join("\n"));
}

function handleList(
  tasks: Map<string, BackgroundTask>,
  statusFilter: string
): McpResult {
  let filtered = [...tasks.values()];
  
  if (statusFilter !== "all") {
    filtered = filtered.filter((t) => t.status === statusFilter);
  }
  
  if (filtered.length === 0) {
    return formatToolResult(`No ${statusFilter === "all" ? "" : statusFilter + " "}tasks`);
  }
  
  const lines = filtered.map((t) => {
    const icon = t.status === "running" ? "⏳" : t.status === "completed" ? "✓" : "✗";
    return `${icon} ${t.id} (${t.status}, ${formatDuration(t)})`;
  });
  
  return formatToolResult(lines.join("\n"));
}

async function runCommand(
  ctx: ToolContext,
  label: string,
  command: string
): Promise<string> {
  const start = Date.now();
  const result = await ctx.sandbox.execute(`await $\`${command}\``, {})
    .catch((e: Error) => ({ error: e.message }));
  
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  if ("error" in result) return `✗ ${label}: ${result.error}`;
  
  const output = result.value ? `\n  ${String(result.value).slice(0, 200)}` : "";
  return `✓ ${label} (${duration}s)${output}`;
}

async function handleCommands(
  ctx: ToolContext,
  commands: Array<{ label: string; command: string }>
): Promise<McpResult> {
  const results = await Promise.all(
    commands.map((c) => runCommand(ctx, c.label, c.command))
  );
  return formatToolResult(results.join("\n"));
}

function storeResult(ctx: ToolContext, name: string, value: unknown): void {
  ctx.variables.stored.set(name, { value, timestamp: Date.now(), source: "mcx_tasks" });
}

async function runOperation(
  ctx: ToolContext,
  code: string,
  storeAs?: string
): Promise<string> {
  const result = await ctx.sandbox.execute(code, {})
    .catch((e: Error) => ({ error: e.message }));
  
  if ("error" in result) return `✗ ${code.slice(0, 50)}: ${result.error}`;
  
  const json = JSON.stringify(result.value);
  if (storeAs) {
    storeResult(ctx, storeAs, result.value);
    return `✓ $${storeAs} = ${json.slice(0, 100)}`;
  }
  return `✓ ${json.slice(0, 150)}`;
}

async function handleOperations(
  ctx: ToolContext,
  operations: Array<{ code: string; storeAs?: string }>
): Promise<McpResult> {
  const results: string[] = [];
  for (const op of operations) {
    results.push(await runOperation(ctx, op.code, op.storeAs));
  }
  return formatToolResult(results.join("\n"));
}

// ============================================================================
// Main Handler (dispatch only - no logic)
// ============================================================================

async function handleTasks(
  ctx: ToolContext,
  params: TasksParams
): Promise<McpResult> {
  // Spawn mode: code provided
  if (params.code) {
    return handleSpawn(ctx, params.code, params.label);
  }
  
  // Check by ID
  if (params.id) {
    return handleCheckById(ctx.backgroundTasks, params.id);
  }
  
  // Commands mode
  if (params.commands?.length) {
    return handleCommands(ctx, params.commands);
  }
  
  // Operations mode
  if (params.operations?.length) {
    return handleOperations(ctx, params.operations);
  }
  
  // Default: list tasks
  return handleList(ctx.backgroundTasks, params.status || "all");
}

// ============================================================================
// Tool Definition
// ============================================================================

export const mcxTasks: ToolDefinition<TasksParams> = {
  name: "mcx_tasks",
  description: `Background tasks and batch operations.

**Spawn task:** mcx_tasks({ code: "await slowApi.process()", label: "job1" })
**Check task:** mcx_tasks({ id: "job1" })
**List tasks:** mcx_tasks() or mcx_tasks({ status: "running" })
**Commands:** mcx_tasks({ commands: [{ label: "build", command: "npm run build" }] })
**Operations:** mcx_tasks({ operations: [{ code: "api.getUsers()", storeAs: "users" }] })`,
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "Code to spawn in background" },
      label: { type: "string", description: "Label for spawned task" },
      id: { type: "string", description: "Get specific task by ID" },
      status: {
        type: "string",
        enum: ["all", "running", "completed", "failed"],
        description: "Filter tasks by status",
      },
      commands: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            command: { type: "string" },
          },
          required: ["label", "command"],
        },
        description: "Shell commands to run sequentially",
      },
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            storeAs: { type: "string" },
          },
          required: ["code"],
        },
        description: "Code operations to run sequentially",
      },
    },
  },
  handler: handleTasks,
};

export default mcxTasks;
