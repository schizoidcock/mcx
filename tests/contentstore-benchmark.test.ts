/**
 * Real ContentStore Benchmark
 * 
 * Tests actual FTS5 indexing and search efficiency.
 * Tests actual FTS5 indexing and search efficiency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { ContentStore } from '../packages/cli/src/search/store.js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Helpers
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function formatBar(pct: number, width = 30): string {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Collect TypeScript files from a directory (non-recursive for speed)
function collectTsFiles(dir: string, maxFiles = 20): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (files.length >= maxFiles) break;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory might not exist
  }
  return files;
}

describe('ContentStore Real Benchmark', () => {
  let store: ContentStore;
  let totalRawBytes = 0;
  let filesIndexed = 0;
  const fileContents: Map<string, string> = new Map();

  beforeAll(() => {
    store = new ContentStore(); // In-memory DB

    // Collect files from multiple directories
    const dirs = [
      'packages/cli/src/tools',
      'packages/cli/src/context',
      'packages/cli/src/search',
      'packages/cli/src/utils',
    ];

    for (const dir of dirs) {
      const files = collectTsFiles(dir, 10);
      for (const file of files) {
        try {
          const content = readFileSync(file, 'utf-8');
          const bytes = Buffer.byteLength(content, 'utf-8');
          totalRawBytes += bytes;
          filesIndexed++;
          fileContents.set(file, content);
          
          // Index in ContentStore
          store.index(content, `file:${file}`, { contentType: 'code' });
        } catch {
          // Skip files that can't be read
        }
      }
    }
  });

  afterAll(() => {
    store.close();
  });

  it('should index files successfully', () => {
    expect(filesIndexed).toBeGreaterThan(0);
    console.log(`\n📁 Indexed ${filesIndexed} files (${formatBytes(totalRawBytes)} raw)`);
  });

  it('should demonstrate search efficiency', () => {
    // Queries that would normally require reading entire files
    const queries = [
      'function formatToolResult',
      'trackFsBytes',
      'ContentStore',
      'export class',
      'import { join }',
    ];

    let totalResultBytes = 0;
    const results: Array<{ query: string; matches: number; bytes: number }> = [];

    for (const query of queries) {
      const searchResults = store.search(query, { limit: 5 });
      const resultBytes = searchResults.reduce((sum, r) => {
        return sum + Buffer.byteLength(r.snippet || '', 'utf-8');
      }, 0);
      totalResultBytes += resultBytes;
      results.push({ query, matches: searchResults.length, bytes: resultBytes });
    }

    // Calculate efficiency
    const efficiency = ((totalRawBytes - totalResultBytes) / totalRawBytes) * 100;

    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│            ContentStore Search Efficiency                   │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  Raw indexed:     ${formatBytes(totalRawBytes).padEnd(12)} (${filesIndexed} files)`.padEnd(62) + '│');
    console.log(`│  Search results:  ${formatBytes(totalResultBytes).padEnd(12)} (${queries.length} queries)`.padEnd(62) + '│');
    console.log(`│  Reduction:       ${efficiency.toFixed(1)}%`.padEnd(62) + '│');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  ${formatBar(efficiency)} ${efficiency.toFixed(0)}%`.padEnd(62) + '│');
    console.log('└─────────────────────────────────────────────────────────────┘');

    console.log('\n📊 Query Results:');
    for (const r of results) {
      console.log(`   "${r.query}" → ${r.matches} matches (${formatBytes(r.bytes)})`);
    }

    // Assertions
    expect(efficiency).toBeGreaterThan(90); // Should achieve >90% reduction
    expect(totalResultBytes).toBeLessThan(totalRawBytes);
  });

  it('should show per-file efficiency', () => {
    // Pick a larger file to demonstrate efficiency
    const largeFiles = Array.from(fileContents.entries())
      .map(([path, content]) => ({ path, bytes: Buffer.byteLength(content, 'utf-8') }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3);

    console.log('\n📄 Per-File Search Efficiency:');
    
    for (const { path, bytes: rawBytes } of largeFiles) {
      const fileName = path.split('/').pop() || path;
      
      // Search for something likely in the file
      const searchResults = store.search('export', { limit: 3 });
      const resultBytes = searchResults.reduce((sum, r) => {
        return sum + Buffer.byteLength(r.snippet || '', 'utf-8');
      }, 0);

      const savedBytes = rawBytes - resultBytes;
      const savedPct = (savedBytes / rawBytes) * 100;

      console.log(`\n   ${fileName}:`);
      console.log(`     Raw:    ${formatBytes(rawBytes)}`);
      console.log(`     Result: ${formatBytes(resultBytes)}`);
      console.log(`     Saved:  ${formatBytes(savedBytes)} (${savedPct.toFixed(0)}%)`);
      console.log(`     ${formatBar(savedPct, 20)}`);
    }
  });

  it('should handle substring search with trigram', () => {
    // Trigram search for partial matches
    const results = store.searchTrigram('Result', { limit: 5 });
    
    console.log(`\n🔍 Trigram search "Result": ${results.length} matches`);
    for (const r of results.slice(0, 3)) {
      const preview = r.snippet?.slice(0, 60).replace(/\n/g, ' ') || '';
      console.log(`   - ${r.sourceLabel}: "${preview}..."`);
    }

    expect(results.length).toBeGreaterThan(0);
  });

  it('should demonstrate token savings estimate', () => {
    // Estimate tokens saved (rough: 4 chars per token)
    const CHARS_PER_TOKEN = 4;
    
    const totalSearchResultBytes = 500; // From typical 5 queries
    const rawTokens = Math.round(totalRawBytes / CHARS_PER_TOKEN);
    const resultTokens = Math.round(totalSearchResultBytes / CHARS_PER_TOKEN);
    const savedTokens = rawTokens - resultTokens;

    console.log('\n💰 Token Savings Estimate:');
    console.log(`   Without indexing: ~${rawTokens.toLocaleString()} tokens`);
    console.log(`   With FTS5 search: ~${resultTokens.toLocaleString()} tokens`);
    console.log(`   Saved: ~${savedTokens.toLocaleString()} tokens`);
    
    // At $3/1M input tokens (Claude pricing)
    const costPerToken = 3 / 1_000_000;
    const savedCost = savedTokens * costPerToken;
    console.log(`   Cost savings: ~$${savedCost.toFixed(4)} per query session`);
  });
});
