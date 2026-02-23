import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { getMcxHomeDir } from "../utils/paths";

const MCX_CORE_VERSION = "^0.1.0";
const MCX_ADAPTERS_VERSION = "^0.1.0";

// Auto-loading config template that discovers adapters from adapters/
const CONFIG_TEMPLATE = `import { defineConfig } from "@papicandela/mcx-core";
import { readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adaptersDir = join(__dirname, "adapters");

// Auto-load all adapters from adapters/
const adapters: unknown[] = [];

if (existsSync(adaptersDir)) {
  const adapterFiles = readdirSync(adaptersDir).filter(f => f.endsWith(".ts"));

  for (const file of adapterFiles) {
    try {
      const filePath = join(adaptersDir, file);
      const fileUrl = pathToFileURL(filePath).href;
      const mod = await import(fileUrl);
      const adapter = mod.default || Object.values(mod)[0];
      if (adapter && adapter.name && adapter.tools) {
        adapters.push(adapter);
      }
    } catch (e) {
      console.error(\`Failed to load adapter \${file}:\`, e);
    }
  }
}

export default defineConfig({
  sandbox: { timeout: 30000 },
  adapters,
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

const ENV_TEMPLATE = `# MCX Environment Variables
# Add your API credentials here

# Example:
# STRIPE_API_KEY=sk_test_...
# OPENAI_API_KEY=sk-...
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
    pkg = {
      name: "mcx-global",
      version: "0.1.0",
      type: "module",
      private: true,
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
  const mcxHome = getMcxHomeDir();

  console.log(pc.cyan("Initializing global MCX directory...\n"));
  console.log(pc.dim(`  Location: ${mcxHome}\n`));

  // Create ~/.mcx directory
  if (!(await exists(mcxHome))) {
    await mkdir(mcxHome, { recursive: true });
    console.log(pc.green("  Created ~/.mcx/"));
  } else {
    console.log(pc.dim("  ~/.mcx/ already exists"));
  }

  // Create/update package.json with dependencies
  const needsInstall = await ensurePackageJson(mcxHome);

  // Create adapters directory
  const adaptersDir = join(mcxHome, "adapters");
  if (!(await exists(adaptersDir))) {
    await mkdir(adaptersDir, { recursive: true });
    console.log(pc.green("  Created adapters/"));
  } else {
    console.log(pc.dim("  adapters/ already exists"));
  }

  // Create skills directory
  const skillsDir = join(mcxHome, "skills");
  if (!(await exists(skillsDir))) {
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(skillsDir, "hello.ts"), EXAMPLE_SKILL);
    console.log(pc.green("  Created skills/ with example skill"));
  } else {
    console.log(pc.dim("  skills/ already exists"));
  }

  // Create mcx.config.ts with auto-loading
  const configPath = join(mcxHome, "mcx.config.ts");
  if (!(await exists(configPath))) {
    await writeFile(configPath, CONFIG_TEMPLATE);
    console.log(pc.green("  Created mcx.config.ts (auto-loads adapters)"));
  } else {
    console.log(pc.dim("  mcx.config.ts already exists"));
  }

  // Create .env template
  const envPath = join(mcxHome, ".env");
  if (!(await exists(envPath))) {
    await writeFile(envPath, ENV_TEMPLATE);
    console.log(pc.green("  Created .env template"));
  } else {
    console.log(pc.dim("  .env already exists"));
  }

  // Install dependencies if needed
  if (needsInstall) {
    try {
      await runBunInstall(mcxHome);
      console.log(pc.green("\n  Dependencies installed successfully"));
    } catch (error) {
      console.log(pc.yellow("\n  Failed to install dependencies. Run 'bun install' in ~/.mcx/ manually."));
    }
  }

  console.log(pc.cyan("\nMCX initialized!"));
  console.log(pc.dim("\nUsage:"));
  console.log(pc.dim("  1. Generate adapters:  mcx gen <openapi-spec> -n <name>"));
  console.log(pc.dim("  2. Add credentials:    Edit ~/.mcx/.env"));
  console.log(pc.dim("  3. Start server:       mcx serve"));
  console.log(pc.dim("\nClaude Code config (no path needed):"));
  console.log(pc.dim('  { "mcpServers": { "mcx": { "command": "mcx", "args": ["serve"] } } }'));
}
