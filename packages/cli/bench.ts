#!/usr/bin/env bun
/**
 * MCX Benchmark - Measure execution time for common operations
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const ITERATIONS = 5;
const TARGET_DIR = process.cwd();
const TARGET_FILE = "src/commands/serve.ts";

function measure(name: string, fn: () => void): number {
  const times: number[] = [];
  
  // Warmup
  fn();
  
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${name}: ${avg.toFixed(2)}ms (avg of ${ITERATIONS})`);
  return avg;
}

console.log("=== MCX Benchmark ===\n");
console.log(`Target: ${TARGET_DIR}`);
console.log(`File: ${TARGET_FILE}\n`);

// Test 1: File read
measure("File read (6K lines)", () => {
  readFileSync(join(TARGET_DIR, TARGET_FILE), "utf-8");
});

// Test 2: File read + split lines
measure("File read + split", () => {
  const content = readFileSync(join(TARGET_DIR, TARGET_FILE), "utf-8");
  content.split("\n");
});

// Test 3: File read + grep simulation
measure("File read + grep", () => {
  const content = readFileSync(join(TARGET_DIR, TARGET_FILE), "utf-8");
  const lines = content.split("\n");
  lines.filter(l => l.includes("function"));
});

// Test 4: Directory scan (find simulation)
measure("Dir scan (recursive)", () => {
  const files: string[] = [];
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        scan(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        files.push(path);
      }
    }
  }
  scan(join(TARGET_DIR, "src"));
});

// Test 5: Regex matching
measure("Regex match (1000x)", () => {
  const content = readFileSync(join(TARGET_DIR, TARGET_FILE), "utf-8");
  const regex = /function\s+(\w+)/g;
  for (let i = 0; i < 1000; i++) {
    [...content.matchAll(regex)];
  }
});

// Test 6: JSON parse/stringify
const testObj = { items: Array(1000).fill({ id: 1, name: "test", value: 123.45 }) };
measure("JSON stringify (1K obj)", () => {
  JSON.stringify(testObj);
});

measure("JSON parse (1K obj)", () => {
  JSON.parse(JSON.stringify(testObj));
});

console.log("\n=== Done ===");
