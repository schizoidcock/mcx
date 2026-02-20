import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";

const MCX_CORE_VERSION = "^0.1.0";
const MCX_ADAPTERS_VERSION = "^0.1.0";

const CONFIG_TEMPLATE = `import { defineConfig } from "@papicandela/mcx-core";

export default defineConfig({
  // Sandbox configuration
  sandbox: {
    timeout: 30000,
    maxMemory: 256,
  },

  // Available adapters
  adapters: [
    // Add your adapters here
    // example,
  ],

  // Skill directories
  skills: ["./skills"],
});
`;

const EXAMPLE_SKILL = `import { defineSkill } from "@papicandela/mcx-core";

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

const EXAMPLE_ADAPTER = `import { defineAdapter } from "@papicandela/mcx-adapters";

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

async function ensurePackageJson(cwd: string): Promise<boolean> {
  const pkgPath = join(cwd, "package.json");
  let pkg: Record<string, unknown> = {};
  let created = false;

  if (await exists(pkgPath)) {
    try {
      const content = await readFile(pkgPath, "utf-8");
      pkg = JSON.parse(content);
    } catch {
      pkg = {};
    }
  } else {
    // Create minimal package.json
    const dirName = cwd.split(/[\\/]/).pop() || "mcx-project";
    pkg = {
      name: dirName,
      version: "0.1.0",
      type: "module",
    };
    created = true;
  }

  // Ensure dependencies exist
  if (!pkg.dependencies) {
    pkg.dependencies = {};
  }

  const deps = pkg.dependencies as Record<string, string>;
  let needsInstall = false;

  if (!deps["@papicandela/mcx-core"]) {
    deps["@papicandela/mcx-core"] = MCX_CORE_VERSION;
    needsInstall = true;
  }

  if (!deps["@papicandela/mcx-adapters"]) {
    deps["@papicandela/mcx-adapters"] = MCX_ADAPTERS_VERSION;
    needsInstall = true;
  }

  // Write package.json
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  if (created) {
    console.log(pc.green("  Created package.json"));
  } else if (needsInstall) {
    console.log(pc.green("  Updated package.json with MCX dependencies"));
  } else {
    console.log(pc.dim("  package.json already has MCX dependencies"));
  }

  return needsInstall || created;
}

async function runBunInstall(cwd: string): Promise<void> {
  console.log(pc.cyan("\n  Installing dependencies..."));

  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["install"], {
      cwd,
      stdio: "inherit",
      shell: true,
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`bun install failed with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

export async function initCommand(): Promise<void> {
  const cwd = process.cwd();

  console.log(pc.cyan("Initializing MCX project...\n"));

  // Create/update package.json with dependencies
  const needsInstall = await ensurePackageJson(cwd);

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

  // Install dependencies if needed
  if (needsInstall) {
    try {
      await runBunInstall(cwd);
      console.log(pc.green("\n  Dependencies installed successfully"));
    } catch (error) {
      console.log(pc.yellow("\n  Failed to install dependencies. Run 'bun install' manually."));
    }
  }

  console.log(pc.cyan("\nMCX project initialized!"));
  console.log(pc.dim("\nNext steps:"));
  console.log(pc.dim("  1. Configure MCP in .mcp.json to point to this project"));
  console.log(pc.dim("  2. Add your adapters in the adapters/ directory"));
  console.log(pc.dim("  3. Run 'mcx serve' to start the MCP server"));
}
