/**
 * MCX File Indexer Daemon
 * 
 * Polls FFF's drainChanges() from multiple watched projects and re-indexes
 * changed files in FTS5. FFF handles file watching internally.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { relative, extname, basename } from 'path';
import { getContentStore } from '../search';
import type { FileFinder } from '@ff-labs/fff-bun';

// Poll interval for checking FFF changes
const POLL_INTERVAL_MS = 1000;

// Extensions to index content for
const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.md', '.mdx', '.yaml', '.yml',
  '.html', '.css', '.scss', '.less',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.prisma',
]);

interface DaemonOptions {
  watchedProjects: Map<string, FileFinder>;
  onIndex?: (path: string, project: string) => void;
  onError?: (error: Error) => void;
}

export class FileIndexerDaemon {
  private pollTimer: Timer | null = null;
  private watchedProjects: Map<string, FileFinder>;
  private isProcessing = false;
  private onIndex?: (path: string, project: string) => void;
  private onError?: (error: Error) => void;

  constructor(options: DaemonOptions) {
    this.watchedProjects = options.watchedProjects;
    this.onIndex = options.onIndex;
    this.onError = options.onError;
  }

  start(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.processChanges(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async processChanges(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const store = getContentStore();

      // Poll all watched projects
      for (const [projectPath, finder] of this.watchedProjects) {
        const changedPaths = finder.drainChanges();
        if (changedPaths.length === 0) continue;

        for (const fullPath of changedPaths) {
          try {
            const ext = extname(fullPath).toLowerCase();
            if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

            const label = relative(projectPath, fullPath);

            // Check if file was deleted
            if (!existsSync(fullPath)) {
              store.deleteByLabel(label);
              this.onIndex?.(fullPath, projectPath); // Still notify (deletion)
              continue;
            }

            const content = await readFile(fullPath, 'utf-8');
            
            store.reindex(content, label, {
              contentType: this.getContentType(fullPath),
            });

            this.onIndex?.(fullPath, projectPath);
          } catch (error) {
            this.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private getContentType(path: string): 'markdown' | 'code' | 'plaintext' {
    const ext = extname(path).toLowerCase();
    if (ext === '.md' || ext === '.mdx') return 'markdown';
    if (INDEXABLE_EXTENSIONS.has(ext)) return 'code';
    return 'plaintext';
  }
}

// Singleton daemon instance
let daemon: FileIndexerDaemon | null = null;

export function startDaemon(watchedProjects: Map<string, FileFinder>): FileIndexerDaemon {
  if (daemon) {
    daemon.stop();
  }
  daemon = new FileIndexerDaemon({
    watchedProjects,
    onIndex: (path, project) => console.error(`[daemon] Indexed: ${basename(path)} (${basename(project)})`),
    onError: (error) => console.error(`[daemon] Error: ${error.message}`),
  });
  daemon.start();
  return daemon;
}

export function stopDaemon(): void {
  if (daemon) {
    daemon.stop();
    daemon = null;
  }
}

export function getDaemon(): FileIndexerDaemon | null {
  return daemon;
}
