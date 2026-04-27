/**
 * MCX File Indexer Daemon
 * 
 * Polls FFF's drainChanges() from watched projects and re-indexes
 * changed files in FTS5. FFF handles file watching internally.
 * 
 * Linus principles:
 * - Max 3 indent levels (extract helpers)
 * - Functions 10-15 lines
 * - Early returns
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, extname, basename } from 'node:path';
import { getContentStore } from '../search';
import { DAEMON_POLL_INTERVAL_MS, INDEXABLE_EXTENSIONS } from '../tools/constants.js';
import type { FileFinder } from '@ff-labs/fff-bun';

import { createDebugger } from "../utils/debug.js";

const debug = createDebugger("daemon");

// ============================================================================
// Types
// ============================================================================

interface DaemonOptions {
  watchedProjects: Map<string, FileFinder>;
  onIndex?: (path: string, project: string) => void;
  onError?: (error: Error) => void;
}

type ContentType = 'markdown' | 'code' | 'plaintext';

// ============================================================================
// Helpers (Linus: extract to flatten indentation)
// ============================================================================

function getContentType(path: string): ContentType {
  const ext = extname(path).toLowerCase();
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (INDEXABLE_EXTENSIONS.has(ext)) return 'code';
  return 'plaintext';
}

function shouldIndex(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return INDEXABLE_EXTENSIONS.has(ext);
}

async function indexFile(
  fullPath: string,
  projectPath: string,
  store: ReturnType<typeof getContentStore>
): Promise<void> {
  const label = relative(projectPath, fullPath);

  // Deleted file - remove from index
  if (!existsSync(fullPath)) {
    store.deleteByLabel(label);
    return;
  }

  // Index content
  const content = await readFile(fullPath, 'utf-8');
  store.index(content, label, { contentType: getContentType(fullPath) });
}

function drainProjectChanges(finder: FileFinder): string[] {
  const result = finder.drainChanges();
  if (!result.ok) return [];
  return result.value;
}

// ============================================================================
// Daemon Class (Linus: minimal class, logic in helpers)
// ============================================================================

export class FileIndexerDaemon {
  private pollTimer: Timer | null = null;
  private isProcessing = false;
  private watchedProjects: Map<string, FileFinder>;
  private onIndex?: (path: string, project: string) => void;
  private onError?: (error: Error) => void;

  constructor(options: DaemonOptions) {
    this.watchedProjects = options.watchedProjects;
    this.onIndex = options.onIndex;
    this.onError = options.onError;
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), DAEMON_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await this.processAllProjects();
    } finally {
      this.isProcessing = false;
    }
  }

  private async processAllProjects(): Promise<void> {
    const store = getContentStore();
    for (const [projectPath, finder] of this.watchedProjects) {
      await this.processProject(projectPath, finder, store);
    }
  }

  private async processProject(
    projectPath: string,
    finder: FileFinder,
    store: ReturnType<typeof getContentStore>
  ): Promise<void> {
    const changedPaths = drainProjectChanges(finder);
    for (const fullPath of changedPaths) {
      await this.processFile(fullPath, projectPath, store);
    }
  }

  private async processFile(
    fullPath: string,
    projectPath: string,
    store: ReturnType<typeof getContentStore>
  ): Promise<void> {
    if (!shouldIndex(fullPath)) return;
    try {
      await indexFile(fullPath, projectPath, store);
      this.onIndex?.(fullPath, projectPath);
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// ============================================================================
// Singleton (Linus: simple module-level state)
// ============================================================================

let daemon: FileIndexerDaemon | null = null;

export function startDaemon(watchedProjects: Map<string, FileFinder>): FileIndexerDaemon {
  if (daemon) daemon.stop();
  daemon = new FileIndexerDaemon({
    watchedProjects,
    onIndex: (p, proj) => console.error(`[daemon] Indexed: ${basename(p)} (${basename(proj)})`),
    onError: (e) => console.error(`[daemon] Error: ${e.message}`),
  });
  daemon.start();
  return daemon;
}

export function stopDaemon(): void {
  daemon?.stop();
  daemon = null;
}

export function getDaemon(): FileIndexerDaemon | null {
  return daemon;
}
