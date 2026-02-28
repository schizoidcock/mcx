import { spawn } from "node:child_process";
import { readFile, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import { getMcxHomeDir } from "../utils/paths";

const CLI_PACKAGE = "@papicandela/mcx-cli";
const CORE_PACKAGE = "@papicandela/mcx-core";
const ADAPTERS_PACKAGE = "@papicandela/mcx-adapters";

// Auto-loading config template (must match init.ts)
const CONFIG_TEMPLATE = [
  'import { defineConfig } from "@papicandela/mcx-core";',
  'import { readdirSync, existsSync } from "fs";',
  'import { join, dirname } from "path";',
  'import { fileURLToPath, pathToFileURL } from "url";',
  '',
  'const __dirname = dirname(fileURLToPath(import.meta.url));',
  'const adaptersDir = join(__dirname, "adapters");',
  '',
  '// Auto-load all adapters from adapters/',
  'const adapters: unknown[] = [];',
  '',
  'if (existsSync(adaptersDir)) {',
  '  const adapterFiles = readdirSync(adaptersDir).filter(f => f.endsWith(".ts"));',
  '',
  '  for (const file of adapterFiles) {',
  '    try {',
  '      const filePath = join(adaptersDir, file);',
  '      const fileUrl = pathToFileURL(filePath).href;',
  '      const mod = await import(fileUrl);',
  '      const adapter = mod.default || Object.values(mod)[0];',
  '      if (adapter && adapter.name && adapter.tools) {',
  '        adapters.push(adapter);',
  '      }',
  '    } catch (e) {',
  '      console.error(`Failed to load adapter ${file}:`, e);',
  '    }',
  '  }',
  '}',
  '',
  'export default defineConfig({',
  '  sandbox: { timeout: 30000 },',
  '  adapters,',
  '  skills: ["./skills"],',
  '});',
].join('\n');

interface UpdateOptions {
  cli?: boolean;
  project?: boolean;
  global?: boolean;
  check?: boolean;
}

async function getInstalledVersion(pkg: string): Promise<string | null> {
  try {
    const result = await runCommand("bun", ["pm", "ls", "-g"], true);
    // Look for package@version pattern in output
    const lines = result.split("\n");
    for (const line of lines) {
      if (line.includes(pkg)) {
        const versionMatch = line.match(/@(\d+\.\d+\.\d+)/);
        if (versionMatch) return versionMatch[1];
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getLatestVersion(pkg: string): Promise<string | null> {
  try {
    const result = await runCommand("bun", ["info", pkg, "--json"], true);
    const data = JSON.parse(result);
    return data.version || data["dist-tags"]?.latest || null;
  } catch {
    // Fallback to npm view if bun info fails
    try {
      const result = await runCommand("npm", ["view", pkg, "version"], true);
      return result.trim();
    } catch {
      return null;
    }
  }
}

async function getProjectVersion(pkg: string, cwd: string): Promise<string | null> {
  try {
    const pkgPath = join(cwd, "package.json");
    const content = await readFile(pkgPath, "utf-8");
    const data = JSON.parse(content);
    const version = data.dependencies?.[pkg] || data.devDependencies?.[pkg];
    return version?.replace(/[\^~]/, "") || null;
  } catch {
    return null;
  }
}

function runCommand(cmd: string, args: string[], silent = false, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // SECURITY: Don't use shell: true - it enables command injection via metacharacters
    // spawn can find executables on PATH without the shell
    const proc = spawn(cmd, args, {
      stdio: silent ? "pipe" : "inherit",
      cwd,
    });

    let output = "";
    if (silent && proc.stdout) {
      proc.stdout.on("data", (data) => {
        output += data.toString();
      });
    }

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanGlobalInstall(): Promise<boolean> {
  const mcxHome = getMcxHomeDir();

  if (!(await exists(mcxHome))) {
    console.log(pc.dim("  No global installation found"));
    return true;
  }

  console.log(pc.cyan("\nCleaning global installation..."));
  console.log(pc.dim(`  Location: ${mcxHome}`));

  try {
    // Remove node_modules (will reinstall)
    const nodeModulesPath = join(mcxHome, "node_modules");
    if (await exists(nodeModulesPath)) {
      await rm(nodeModulesPath, { recursive: true, force: true });
      console.log(pc.green("  Removed node_modules/"));
    }

    // Remove bun.lockb (will regenerate)
    const lockPath = join(mcxHome, "bun.lockb");
    if (await exists(lockPath)) {
      await rm(lockPath, { force: true });
      console.log(pc.green("  Removed bun.lockb"));
    }

    // Preserve existing mcx.config.ts (don't overwrite user customizations)
    const configPath = join(mcxHome, "mcx.config.ts");
    if (await exists(configPath)) {
      console.log(pc.dim("  Preserved mcx.config.ts (use 'mcx init --force' to regenerate)"));
    } else {
      await writeFile(configPath, CONFIG_TEMPLATE);
      console.log(pc.green("  Created mcx.config.ts"));
    }

    // Update package.json with latest versions
    const pkgPath = join(mcxHome, "package.json");
    if (await exists(pkgPath)) {
      const content = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(content);
      const deps = pkg.dependencies || {};
      deps[CORE_PACKAGE] = "latest";
      deps[ADAPTERS_PACKAGE] = "latest";
      pkg.dependencies = deps;
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log(pc.green("  Updated package.json to latest versions"));
    }

    // Reinstall dependencies in mcx home directory
    console.log(pc.cyan("\n  Reinstalling dependencies..."));
    await runCommand("bun", ["install"], false, mcxHome);
    console.log(pc.green("  Dependencies reinstalled"));

    console.log(pc.dim("\n  Preserved: mcx.config.ts, adapters/, skills/, .env"));
    return true;
  } catch (error) {
    console.log(pc.red(`  Failed to clean installation: ${error}`));
    return false;
  }
}

async function updateCli(): Promise<boolean> {
  console.log(pc.cyan("\nUpdating MCX CLI..."));

  const installed = await getInstalledVersion(CLI_PACKAGE);
  const latest = await getLatestVersion(CLI_PACKAGE);

  if (!latest) {
    console.log(pc.red("  Failed to fetch latest version from npm"));
    return false;
  }

  if (installed === latest) {
    console.log(pc.green(`  Already at latest version (${latest})`));
    return true;
  }

  console.log(pc.dim(`  ${installed || "not installed"} → ${latest}`));

  try {
    await runCommand("bun", ["install", "-g", `${CLI_PACKAGE}@latest`]);
    console.log(pc.green(`  Updated to ${latest}`));
    return true;
  } catch (error) {
    console.log(pc.red("  Update failed. Try running with sudo or as admin."));
    return false;
  }
}

async function updateProject(cwd: string): Promise<boolean> {
  console.log(pc.cyan("\nUpdating project dependencies..."));

  const pkgPath = join(cwd, "package.json");
  if (!(await exists(pkgPath))) {
    console.log(pc.yellow("  No package.json found in current directory"));
    return false;
  }

  const coreVersion = await getProjectVersion(CORE_PACKAGE, cwd);
  const adaptersVersion = await getProjectVersion(ADAPTERS_PACKAGE, cwd);

  if (!coreVersion && !adaptersVersion) {
    console.log(pc.yellow("  No MCX dependencies found in package.json"));
    return false;
  }

  const latestCore = await getLatestVersion(CORE_PACKAGE);
  const latestAdapters = await getLatestVersion(ADAPTERS_PACKAGE);

  const updates: string[] = [];

  if (coreVersion && latestCore && coreVersion !== latestCore) {
    console.log(pc.dim(`  ${CORE_PACKAGE}: ${coreVersion} → ${latestCore}`));
    updates.push(`${CORE_PACKAGE}@latest`);
  } else if (coreVersion) {
    console.log(pc.green(`  ${CORE_PACKAGE}: ${coreVersion} (up to date)`));
  }

  if (adaptersVersion && latestAdapters && adaptersVersion !== latestAdapters) {
    console.log(pc.dim(`  ${ADAPTERS_PACKAGE}: ${adaptersVersion} → ${latestAdapters}`));
    updates.push(`${ADAPTERS_PACKAGE}@latest`);
  } else if (adaptersVersion) {
    console.log(pc.green(`  ${ADAPTERS_PACKAGE}: ${adaptersVersion} (up to date)`));
  }

  if (updates.length === 0) {
    console.log(pc.green("  All dependencies up to date"));
    return true;
  }

  try {
    console.log(pc.dim("\n  Running bun install..."));
    await runCommand("bun", ["add", ...updates], false);
    console.log(pc.green("  Dependencies updated"));
    return true;
  } catch (error) {
    console.log(pc.red("  Failed to update dependencies"));
    return false;
  }
}

async function checkVersions(cwd: string): Promise<void> {
  console.log(pc.cyan("\nChecking versions...\n"));

  // CLI version
  const installedCli = await getInstalledVersion(CLI_PACKAGE);
  const latestCli = await getLatestVersion(CLI_PACKAGE);

  console.log(pc.bold("CLI:"));
  if (installedCli && latestCli) {
    if (installedCli === latestCli) {
      console.log(pc.green(`  ${CLI_PACKAGE}: ${installedCli} (latest)`));
    } else {
      console.log(pc.yellow(`  ${CLI_PACKAGE}: ${installedCli} → ${latestCli} available`));
    }
  } else {
    console.log(pc.dim(`  ${CLI_PACKAGE}: ${installedCli || "not installed"}`));
  }

  // Project versions
  const pkgPath = join(cwd, "package.json");
  if (await exists(pkgPath)) {
    console.log(pc.bold("\nProject:"));

    const coreVersion = await getProjectVersion(CORE_PACKAGE, cwd);
    const latestCore = await getLatestVersion(CORE_PACKAGE);

    if (coreVersion && latestCore) {
      if (coreVersion === latestCore) {
        console.log(pc.green(`  ${CORE_PACKAGE}: ${coreVersion} (latest)`));
      } else {
        console.log(pc.yellow(`  ${CORE_PACKAGE}: ${coreVersion} → ${latestCore} available`));
      }
    } else if (coreVersion) {
      console.log(pc.dim(`  ${CORE_PACKAGE}: ${coreVersion}`));
    }

    const adaptersVersion = await getProjectVersion(ADAPTERS_PACKAGE, cwd);
    const latestAdapters = await getLatestVersion(ADAPTERS_PACKAGE);

    if (adaptersVersion && latestAdapters) {
      if (adaptersVersion === latestAdapters) {
        console.log(pc.green(`  ${ADAPTERS_PACKAGE}: ${adaptersVersion} (latest)`));
      } else {
        console.log(pc.yellow(`  ${ADAPTERS_PACKAGE}: ${adaptersVersion} → ${latestAdapters} available`));
      }
    } else if (adaptersVersion) {
      console.log(pc.dim(`  ${ADAPTERS_PACKAGE}: ${adaptersVersion}`));
    }

    if (!coreVersion && !adaptersVersion) {
      console.log(pc.dim("  No MCX dependencies found"));
    }
  }

  console.log();
}

export async function updateCommand(options: UpdateOptions): Promise<void> {
  const cwd = process.cwd();

  // Check mode: just show versions
  if (options.check) {
    await checkVersions(cwd);
    return;
  }

  // Default: update CLI and global installation
  const updateAll = !options.cli && !options.project && !options.global;

  if (options.cli || updateAll) {
    await updateCli();
  }

  // Clean and update global installation (~/.mcx/)
  if (options.global || updateAll) {
    await cleanGlobalInstall();
  }

  if (options.project) {
    await updateProject(cwd);
  }

  console.log();
}
