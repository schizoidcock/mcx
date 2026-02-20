import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";

const CONFIG_TEMPLATE = `import { defineConfig } from "@mcx/core";

export default defineConfig({
  // Sandbox configuration
  sandbox: {
    timeout: 30000,
    maxMemory: 256,
  },

  // Available adapters
  adapters: {
    // Add your adapters here
    // example: "./adapters/example.ts",
  },

  // Skill directories
  skills: ["./skills"],
});
`;

const EXAMPLE_SKILL = `import { defineSkill } from "@mcx/core";

export default defineSkill({
  name: "hello",
  description: "A simple hello world skill",

  inputs: {
    name: {
      type: "string",
      description: "Name to greet",
      default: "World",
    },
  },

  async run({ inputs }) {
    return \`Hello, \${inputs.name}!\`;
  },
});
`;

const EXAMPLE_ADAPTER = `import { defineAdapter } from "@mcx/core";

export default defineAdapter({
  name: "example",
  description: "An example adapter",

  tools: {
    greet: {
      description: "Greet someone",
      parameters: {
        name: { type: "string", description: "Name to greet" },
      },
      async execute({ name }) {
        return \`Hello, \${name}!\`;
      },
    },
  },
});
`;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();

  console.log(pc.cyan("Initializing MCX project...\n"));

  // Create mcx.config.ts
  const configPath = join(cwd, "mcx.config.ts");
  if (await exists(configPath)) {
    console.log(pc.yellow("  mcx.config.ts already exists, skipping"));
  } else {
    await writeFile(configPath, CONFIG_TEMPLATE);
    console.log(pc.green("  Created mcx.config.ts"));
  }

  // Create skills directory
  const skillsDir = join(cwd, "skills");
  if (await exists(skillsDir)) {
    console.log(pc.yellow("  skills/ already exists, skipping"));
  } else {
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "hello.ts"), EXAMPLE_SKILL);
    console.log(pc.green("  Created skills/ with example skill"));
  }

  // Create adapters directory
  const adaptersDir = join(cwd, "adapters");
  if (await exists(adaptersDir)) {
    console.log(pc.yellow("  adapters/ already exists, skipping"));
  } else {
    await mkdir(adaptersDir, { recursive: true });
    await writeFile(join(adaptersDir, "example.ts"), EXAMPLE_ADAPTER);
    console.log(pc.green("  Created adapters/ with example adapter"));
  }

  console.log(pc.cyan("\nMCX project initialized!"));
  console.log(pc.dim("\nNext steps:"));
  console.log(pc.dim("  1. Edit mcx.config.ts to configure your project"));
  console.log(pc.dim("  2. Add skills in the skills/ directory"));
  console.log(pc.dim("  3. Run 'mcx serve' to start the MCP server"));
}
