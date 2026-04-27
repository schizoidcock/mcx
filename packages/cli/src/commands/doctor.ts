import pc from "picocolors";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];

  // 1. Bun runtime
  try {
    const bunVersion = Bun.version;
    checks.push({ name: "Bun runtime", status: "pass", detail: `v${bunVersion}` });
  } catch {
    checks.push({ name: "Bun runtime", status: "fail", detail: "Not available" });
  }

  // 2. MCX directory + 3. Adapters (combined check)
  const mcxDir = join(homedir(), ".mcx");
  const adaptersDir = join(mcxDir, "adapters");
  let adapterCount = 0;
  try {
    const entries = await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: adaptersDir }));
    adapterCount = entries.length;
    checks.push({ name: "MCX directory", status: "pass", detail: mcxDir });
    if (adapterCount > 0) {
      checks.push({ name: "Adapters", status: "pass", detail: `${adapterCount} found` });
    } else {
      checks.push({ name: "Adapters", status: "warn", detail: "None found (optional)" });
    }
  } catch {
    checks.push({ name: "MCX directory", status: "warn", detail: `${mcxDir} (will be created on first use)` });
    checks.push({ name: "Adapters", status: "warn", detail: "Directory not found (optional)" });
  }

  // 4. SQLite/FTS5
  let testDb: Database | undefined;
  try {
    testDb = new Database(":memory:");
    testDb.run("CREATE VIRTUAL TABLE test USING fts5(content)");
    checks.push({ name: "SQLite/FTS5", status: "pass", detail: "Available" });
  } catch (e) {
    checks.push({ name: "SQLite/FTS5", status: "fail", detail: String(e) });
  } finally {
    testDb?.close();
  }

  // 5. FFF (optional) - quick check without loading native module
  try {
    // Just resolve the package path, don't load it
    Bun.resolveSync("@ff-labs/fff-bun", process.cwd());
    checks.push({ name: "FFF", status: "pass", detail: "Installed" });
  } catch {
    checks.push({ name: "FFF", status: "warn", detail: "Not installed (optional)" });
  }

  // 6. Version
  const pkg = await import("../../package.json");
  checks.push({ name: "Version", status: "pass", detail: `v${pkg.version}` });

  // Format output
  const icon = (s: Check["status"]) => 
    s === "pass" ? pc.green("✓") : s === "warn" ? pc.yellow("~") : pc.red("✗");
  
  console.log();
  console.log(pc.bold("MCX Diagnostics"));
  console.log(pc.dim("───────────────"));
  
  for (const c of checks) {
    console.log(`${icon(c.status)} ${c.name}: ${c.detail}`);
  }
  
  console.log();
  const passed = checks.filter(c => c.status === "pass").length;
  const failed = checks.filter(c => c.status === "fail").length;
  
  if (failed > 0) {
    console.log(pc.red(`${passed}/${checks.length} checks passed (${failed} failed)`));
  } else {
    console.log(pc.green(`${passed}/${checks.length} checks passed`));
  }
}
