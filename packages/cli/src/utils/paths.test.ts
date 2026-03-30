import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFile, rm, mkdir } from 'node:fs/promises';
import {
  getMcxHomeDir,
  getMcxCliDir,
  getMcxRootDir,
  getAdaptersDir,
  getConfigPath,
  getEnvPath,
  exists,
} from './paths';

describe('getMcxHomeDir', () => {
  test('returns ~/.mcx path', () => {
    const result = getMcxHomeDir();
    expect(result).toBe(join(homedir(), '.mcx'));
  });
});

describe('getMcxRootDir', () => {
  test('returns same as getMcxHomeDir', () => {
    expect(getMcxRootDir()).toBe(getMcxHomeDir());
  });
});

describe('getAdaptersDir', () => {
  test('returns ~/.mcx/adapters path', () => {
    const result = getAdaptersDir();
    expect(result).toBe(join(homedir(), '.mcx', 'adapters'));
  });
});

describe('getConfigPath', () => {
  test('returns ~/.mcx/mcx.config.ts path', () => {
    const result = getConfigPath();
    expect(result).toBe(join(homedir(), '.mcx', 'mcx.config.ts'));
  });
});

describe('getEnvPath', () => {
  test('returns ~/.mcx/.env path', () => {
    const result = getEnvPath();
    expect(result).toBe(join(homedir(), '.mcx', '.env'));
  });
});

describe('getMcxCliDir', () => {
  test('returns path containing packages/cli or is absolute', () => {
    const result = getMcxCliDir();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should be an absolute path (starts with / on Unix or drive letter on Windows)
    const isAbsolute = result.startsWith('/') || /^[A-Za-z]:/.test(result);
    expect(isAbsolute).toBe(true);
  });
});

describe('exists', () => {
  const testDir = join(process.cwd(), '.test-exists-' + process.pid);
  const testFile = join(testDir, 'test-file.txt');

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, 'test content');
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test('returns true for existing file', async () => {
    const result = await exists(testFile);
    expect(result).toBe(true);
  });

  test('returns false for non-existing file', async () => {
    const result = await exists('/nonexistent/path/file.txt');
    expect(result).toBe(false);
  });

  test('returns true for existing directory', async () => {
    const result = await exists(testDir);
    expect(result).toBe(true);
  });
});
