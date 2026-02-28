/**
 * MCX Adapter Generator - CLI Interface
 */
import * as path from "path";
import * as readline from "readline";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import pc from "picocolors";
import { runGeneratorTUI } from "./gen-tui";
import {
  analyzeSource,
  generateAdapter,
  generateSDKAdapter,
  groupByCategory,
  filterEndpoints,
  getDefaultName,
  getDefaultOutput,
  getAuthDescription,
  type DetectedAuth,
  type FilterOptions,
} from "./gen-core";
import { getConfigPath } from "../utils/paths";

// ============================================================================
// Security: Path Validation
// ============================================================================

/**
 * Validate that an output path is within allowed directories to prevent path traversal.
 * Allowed: cwd, ~/.mcx/
 */
async function validateOutputPath(outputPath: string): Promise<string> {
  const cwd = process.cwd();
  const mcxDir = path.join(homedir(), ".mcx");
  const allowedDirs = [cwd, mcxDir];

  // Resolve to absolute path first
  const absolutePath = path.resolve(outputPath);

  // Get the parent directory (the file may not exist yet)
  const parentDir = path.dirname(absolutePath);

  // Resolve to real path (follows symlinks) - parent must exist
  const realParent = await realpath(parentDir).catch(() => parentDir);

  for (const dir of allowedDirs) {
    const realDir = await realpath(dir).catch(() => dir);
    // SECURITY: Check exact match OR path starts with dir + separator
    // This prevents prefix collision (e.g., /home/.mcx-malicious matching /home/.mcx)
    if (realParent === realDir || realParent.startsWith(realDir + "/") || realParent.startsWith(realDir + "\\")) {
      return absolutePath;
    }
  }

  throw new Error(
    `Output path not allowed: ${outputPath}. Must be within current directory or ~/.mcx/`
  );
}

// ============================================================================
// Main Command
// ============================================================================

export async function genCommand(options: {
  source?: string;
  output?: string;
  name?: string;
  baseUrl?: string;
  auth?: string;
  readOnly?: boolean;
  interactive?: boolean;
  include?: string;
  exclude?: string;
}): Promise<void> {
  let { source, output, name, baseUrl, auth, readOnly, include, exclude } = options;

  // Interactive mode - use OpenTUI
  if (options.interactive || !source) {
    const result = await runGeneratorTUI();
    // TUI handles generation internally, null means done or cancelled
    if (!result) {
      return;
    }
    // Non-interactive result (shouldn't happen but handle it)
    source = result.source;
    name = result.name;
    output = result.output;
    baseUrl = result.baseUrl;
    auth = result.auth;
    readOnly = result.readOnly;
  }

  console.log(pc.blue("\n📄 MCX Adapter Generator\n"));

  if (!source) {
    throw new Error("Source is required");
  }

  // Default name from source
  if (!name) {
    name = getDefaultName(source);
  }

  // SECURITY: Validate adapter name to prevent code injection and path traversal
  // Must be a valid JS identifier (letters, digits, underscores, not starting with digit)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid adapter name "${name}". Must be a valid JS identifier (letters, digits, underscores, not starting with a digit).`
    );
  }

  // Default output - always save to MCX adapters directory
  if (!output) {
    output = getDefaultOutput(name);
  }

  console.log(`Source: ${pc.cyan(source)}`);
  console.log(`Output: ${pc.cyan(output)}`);
  console.log(`Adapter name: ${pc.cyan(name)}`);
  if (readOnly) console.log(`Mode: ${pc.yellow("read-only (GET only)")}`);
  console.log();

  // Analyze source
  const analysis = await analyzeSource(source);

  if (!analysis.valid) {
    console.log(pc.red(`\n✗ ${analysis.error}\n`));
    throw new Error(analysis.error);
  }

  console.log(`Found ${pc.yellow(String(analysis.files.length))} markdown file(s)`);
  console.log(`Parsed ${pc.green(String(analysis.endpoints.length))} endpoints from ${analysis.filesWithSpecs.length} file(s)`);

  if (analysis.filesWithoutSpecs.length > 0) {
    console.log(pc.dim(`${analysis.filesWithoutSpecs.length} file(s) had no OpenAPI specs`));
  }

  // Apply filters if specified
  const filterOpts: FilterOptions = {
    include: include ? include.split(",").map(s => s.trim()) : undefined,
    exclude: exclude ? exclude.split(",").map(s => s.trim()) : undefined,
  };

  let endpoints = analysis.endpoints;
  if (filterOpts.include || filterOpts.exclude) {
    endpoints = filterEndpoints(endpoints, filterOpts);
    console.log(`\nFiltered to ${pc.green(String(endpoints.length))} endpoints`);
    if (filterOpts.include) console.log(`  ${pc.dim("include:")} ${filterOpts.include.join(", ")}`);
    if (filterOpts.exclude) console.log(`  ${pc.dim("exclude:")} ${filterOpts.exclude.join(", ")}`);
  }

  if (endpoints.length === 0) {
    console.log(pc.red(`\n✗ No endpoints match the filter criteria.\n`));
    throw new Error("No endpoints match filter criteria");
  }

  // Group endpoints by category
  const byCategory = groupByCategory(endpoints);
  console.log(`\nCategories:`);
  for (const [cat, eps] of Object.entries(byCategory)) {
    console.log(`  ${pc.dim("-")} ${cat}: ${eps.length} endpoints`);
  }

  // Determine base URL
  const detectedBaseUrl = baseUrl || analysis.serverUrl;

  // Use detected auth if no --auth flag provided
  const finalAuth: DetectedAuth | string | null = auth || analysis.auth;

  // Log detected configuration
  if (analysis.auth) {
    console.log(`\nAuth: ${pc.cyan(getAuthDescription(analysis.auth))} ${pc.dim("(auto-detected)")}`);
  }

  if (analysis.sdk) {
    console.log(`SDK: ${pc.cyan(analysis.sdk.packageName)} ${pc.dim(`(${analysis.sdk.language})`)}`);
  }

  // For SDK-based APIs, base URL is optional
  if (!detectedBaseUrl && !analysis.sdk) {
    console.log(pc.red(`\n✗ No base URL detected from OpenAPI specs.`));
    console.log(`Use ${pc.cyan("--base-url")} to specify the API base URL.`);
    throw new Error("Base URL is required. Use --base-url or ensure OpenAPI specs have a 'servers' field.");
  }

  // Generate adapter code
  const adapterCode = analysis.sdk
    ? generateSDKAdapter(name, endpoints, analysis.sdk)
    : generateAdapter(name, endpoints, detectedBaseUrl!, finalAuth);

  // SECURITY: Validate output path before writing (prevents path traversal)
  const validatedOutput = await validateOutputPath(output);

  // Write output
  await Bun.write(validatedOutput, adapterCode);

  console.log(`\n${pc.green("✓")} Generated adapter: ${pc.cyan(output)}`);
  console.log(`\nAdapter "${name}" has ${endpoints.length} methods ready to use.`);

  // Offer to import
  await promptImportAdapter(name, output);
}

// ============================================================================
// Config Import Helper
// ============================================================================

async function promptImportAdapter(adapterName: string, adapterPath: string): Promise<void> {
  const configPath = getConfigPath();
  const configFile = Bun.file(configPath);

  if (!(await configFile.exists())) {
    console.log(pc.dim(`\nNo mcx.config.ts found in current directory.`));
    console.log(pc.dim(`To use this adapter, import it manually in your config.\n`));
    return;
  }

  const importPath = getRelativeImportPath(configPath, adapterPath);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`\nImport into mcx.config.ts? [y/N]: `, resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
    console.log(pc.dim(`\nSkipped. To import manually, add to mcx.config.ts:`));
    console.log(pc.cyan(`  import { ${adapterName} } from '${importPath}';`));
    console.log(pc.cyan(`  // Then add ${adapterName} to the adapters array\n`));
    return;
  }

  const configContent = await configFile.text();
  const importStatement = `import { ${adapterName} } from '${importPath}';`;

  // Check if adapter name already exists (different file, same name)
  // SECURITY: Escape adapterName for regex to prevent ReDoS
  const escapedName = adapterName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameExistsRegex = new RegExp(`import\\s*\\{[^}]*\\b${escapedName}\\b[^}]*\\}`, "m");
  if (nameExistsRegex.test(configContent)) {
    console.log(pc.yellow(`\nAdapter "${adapterName}" already exists in config. Rename the adapter first.`));
    return;
  }

  if (configContent.includes(`from '${importPath}'`) || configContent.includes(`from "${importPath}"`)) {
    console.log(pc.yellow(`\nAdapter already imported in mcx.config.ts`));
    return;
  }

  const lines = configContent.split("\n");
  let lastImportIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("import ")) {
      lastImportIndex = i;
    }
  }

  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importStatement);
  } else {
    lines.unshift(importStatement);
  }

  let newContent = lines.join("\n");
  const adaptersRegex = /adapters:\s*\[([^\]]*)\]/s;
  const match = newContent.match(adaptersRegex);

  if (match) {
    let currentAdapters = match[1];

    // Remove comments and clean up
    const cleanedAdapters = currentAdapters
      .split('\n')
      .map(line => {
        // Remove inline comments
        const commentIndex = line.indexOf('//');
        if (commentIndex !== -1) {
          return line.slice(0, commentIndex);
        }
        return line;
      })
      .join('\n')
      .trim();

    // Extract actual adapter names (non-empty, non-whitespace tokens)
    const adapterTokens = cleanedAdapters
      .split(/[,\s]+/)
      .filter(token => token.length > 0 && token !== ',');

    // Add new adapter
    adapterTokens.push(adapterName);

    // Format the new adapters array
    const newAdapters = adapterTokens.length > 0
      ? adapterTokens.join(', ')
      : adapterName;

    newContent = newContent.replace(adaptersRegex, `adapters: [${newAdapters}]`);
  }

  await Bun.write(configPath, newContent);
  console.log(pc.green(`\n✓ Added ${adapterName} to mcx.config.ts\n`));
}

function getRelativeImportPath(configPath: string, adapterPath: string): string {
  const configDir = path.dirname(configPath);
  let relative = path.relative(configDir, adapterPath);
  relative = relative.replace(/\\/g, "/");
  relative = relative.replace(/\.ts$/, "");
  if (!relative.startsWith(".")) {
    relative = "./" + relative;
  }
  return relative;
}
