import { readFile, access } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import pc from "picocolors";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(): Promise<Record<string, unknown> | null> {
  const cwd = process.cwd();
  const configPath = join(cwd, "mcx.config.ts");

  if (!(await exists(configPath))) {
    return null;
  }

  try {
    // Dynamic import for the config
    const configModule = await import(`file://${configPath}`);
    return configModule.default || configModule;
  } catch (error) {
    console.error(pc.red("Failed to load mcx.config.ts:"), error);
    return null;
  }
}

async function runScript(scriptPath: string): Promise<void> {
  const absolutePath = resolve(process.cwd(), scriptPath);

  if (!(await exists(absolutePath))) {
    console.error(pc.red(`Script not found: ${scriptPath}`));
    process.exit(1);
  }

  console.log(pc.cyan(`Running script: ${scriptPath}\n`));

  try {
    // Dynamic import and execute
    const scriptModule = await import(`file://${absolutePath}`);

    if (typeof scriptModule.default === "function") {
      const result = await scriptModule.default();
      if (result !== undefined) {
        console.log(pc.green("\nResult:"), result);
      }
    } else if (typeof scriptModule.run === "function") {
      const result = await scriptModule.run();
      if (result !== undefined) {
        console.log(pc.green("\nResult:"), result);
      }
    } else {
      console.log(pc.yellow("Script loaded but no default export or run function found"));
    }
  } catch (error) {
    console.error(pc.red("Script execution failed:"), error);
    process.exit(1);
  }
}

async function runSkill(skillName: string, args: string[]): Promise<void> {
  const cwd = process.cwd();
  const skillsDir = join(cwd, "skills");

  // Try to find the skill file
  const possiblePaths = [
    join(skillsDir, `${skillName}.ts`),
    join(skillsDir, `${skillName}.js`),
    join(skillsDir, skillName, "index.ts"),
    join(skillsDir, skillName, "index.js"),
  ];

  let skillPath: string | null = null;
  for (const path of possiblePaths) {
    if (await exists(path)) {
      skillPath = path;
      break;
    }
  }

  if (!skillPath) {
    console.error(pc.red(`Skill not found: ${skillName}`));
    console.log(pc.dim(`Searched in: ${skillsDir}`));
    process.exit(1);
  }

  console.log(pc.cyan(`Running skill: ${skillName}\n`));

  try {
    const skillModule = await import(`file://${skillPath}`);
    const skill = skillModule.default || skillModule;

    if (!skill || typeof skill.run !== "function") {
      console.error(pc.red("Invalid skill: missing run function"));
      process.exit(1);
    }

    // Parse args into inputs
    const inputs: Record<string, string> = {};
    for (const arg of args) {
      const [key, value] = arg.split("=");
      if (key && value !== undefined) {
        inputs[key] = value;
      }
    }

    const result = await skill.run({ inputs });
    if (result !== undefined) {
      console.log(pc.green("\nResult:"), result);
    }
  } catch (error) {
    console.error(pc.red("Skill execution failed:"), error);
    process.exit(1);
  }
}

export async function runCommand(target: string, args: string[]): Promise<void> {
  const ext = extname(target);

  // If it looks like a file path, run as script
  if (ext === ".ts" || ext === ".js" || target.includes("/") || target.includes("\\")) {
    await runScript(target);
  } else {
    // Otherwise, treat as skill name
    await runSkill(target, args);
  }
}
