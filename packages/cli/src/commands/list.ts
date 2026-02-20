import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";

interface Skill {
  name: string;
  description?: string;
  inputs?: Record<string, { type: string; description?: string; default?: unknown }>;
}

interface Adapter {
  name: string;
  description?: string;
  tools?: Record<string, { description?: string }>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  const cwd = process.cwd();
  const skillsDir = join(cwd, "skills");

  if (!(await exists(skillsDir))) {
    return skills;
  }

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });

    for (const entry of entries) {
      let skillPath: string | null = null;
      let skillName = entry.name.replace(/\.(ts|js)$/, "");

      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        skillPath = join(skillsDir, entry.name);
      } else if (entry.isDirectory()) {
        skillName = entry.name;
        const indexTs = join(skillsDir, entry.name, "index.ts");
        const indexJs = join(skillsDir, entry.name, "index.js");
        if (await exists(indexTs)) {
          skillPath = indexTs;
        } else if (await exists(indexJs)) {
          skillPath = indexJs;
        }
      }

      if (skillPath) {
        try {
          const skillModule = await import(`file://${skillPath}`);
          const skill = skillModule.default || skillModule;

          if (skill && typeof skill.run === "function") {
            skills.push({
              name: skill.name || skillName,
              description: skill.description,
              inputs: skill.inputs,
            });
          }
        } catch {
          // Skip invalid skills
          skills.push({
            name: skillName,
            description: "(failed to load)",
          });
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return skills;
}

async function listAdapters(): Promise<Adapter[]> {
  const adapters: Adapter[] = [];
  const cwd = process.cwd();
  const adaptersDir = join(cwd, "adapters");

  if (!(await exists(adaptersDir))) {
    return adapters;
  }

  try {
    const entries = await readdir(adaptersDir, { withFileTypes: true });

    for (const entry of entries) {
      let adapterPath: string | null = null;
      let adapterName = entry.name.replace(/\.(ts|js)$/, "");

      if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        adapterPath = join(adaptersDir, entry.name);
      } else if (entry.isDirectory()) {
        adapterName = entry.name;
        const indexTs = join(adaptersDir, entry.name, "index.ts");
        const indexJs = join(adaptersDir, entry.name, "index.js");
        if (await exists(indexTs)) {
          adapterPath = indexTs;
        } else if (await exists(indexJs)) {
          adapterPath = indexJs;
        }
      }

      if (adapterPath) {
        try {
          const adapterModule = await import(`file://${adapterPath}`);
          const adapter = adapterModule.default || adapterModule;

          adapters.push({
            name: adapter.name || adapterName,
            description: adapter.description,
            tools: adapter.tools,
          });
        } catch {
          // Skip invalid adapters
          adapters.push({
            name: adapterName,
            description: "(failed to load)",
          });
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return adapters;
}

export async function listCommand(): Promise<void> {
  const cwd = process.cwd();

  console.log(pc.cyan("MCX Resources\n"));

  // List skills
  console.log(pc.bold("Skills:"));
  const skills = await listSkills();

  if (skills.length === 0) {
    console.log(pc.dim("  No skills found in skills/"));
    console.log(pc.dim("  Run 'mcx init' to create example skills"));
  } else {
    for (const skill of skills) {
      console.log(`  ${pc.green(skill.name)}`);
      if (skill.description) {
        console.log(pc.dim(`    ${skill.description}`));
      }
      if (skill.inputs && Object.keys(skill.inputs).length > 0) {
        console.log(pc.dim(`    inputs: ${Object.keys(skill.inputs).join(", ")}`));
      }
    }
  }

  console.log();

  // List adapters
  console.log(pc.bold("Adapters:"));
  const adapters = await listAdapters();

  if (adapters.length === 0) {
    console.log(pc.dim("  No adapters found in adapters/"));
    console.log(pc.dim("  Run 'mcx init' to create example adapters"));
  } else {
    for (const adapter of adapters) {
      console.log(`  ${pc.green(adapter.name)}`);
      if (adapter.description) {
        console.log(pc.dim(`    ${adapter.description}`));
      }
      if (adapter.tools && Object.keys(adapter.tools).length > 0) {
        console.log(pc.dim(`    tools: ${Object.keys(adapter.tools).join(", ")}`));
      }
    }
  }

  console.log();
  console.log(pc.dim(`Working directory: ${cwd}`));
}
