import { spawn } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";

const CLI_PACKAGE = "@papicandela/mcx-cli";
const CORE_PACKAGE = "@papicandela/mcx-core";
const ADAPTERS_PACKAGE = "@papicandela/mcx-adapters";

interface UpdateOptions {
  cli?: boolean;
  project?: boolean;
  check?: boolean;
}

async function getInstalledVersion(pkg: string): Promise<string | null> {
  try {
    const result = await runCommand("npm", ["list", pkg, "--json", "-g"], true);
    const data = JSON.parse(result);
    return data.dependencies?.[pkg]?.version || null;
  } catch {
    return null;
  }
}

async function getLatestVersion(pkg: string): Promise<string | null> {
  try {
    const result = await runCommand("npm", ["view", pkg, "version"], true);
    return result.trim();
  } catch {
    return null;
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

function runCommand(cmd: string, args: string[], silent = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      shell: true,
      stdio: silent ? "pipe" : "inherit",
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
    await runCommand("npm", ["install", "-g", `${CLI_PACKAGE}@latest`]);
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

  // Default: update both CLI and project
  const updateBoth = !options.cli && !options.project;

  if (options.cli || updateBoth) {
    await updateCli();
  }

  if (options.project || updateBoth) {
    await updateProject(cwd);
  }

  console.log();
}
