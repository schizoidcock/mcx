/**
 * Orphan Process Guard
 * 
 * Detects when parent process dies to prevent zombie MCP servers.
 * Linus principles: Simple polling, early returns, cleanup returned.
 */

export interface OrphanGuardOptions {
  intervalMs?: number;
  onOrphan: () => void;
}

/**
 * Start orphan detection guard.
 * Returns cleanup function to stop the guard.
 */
export function startOrphanGuard(opts: OrphanGuardOptions): () => void {
  const interval = opts.intervalMs ?? 30_000;
  const initialPpid = process.ppid;
  let stopped = false;

  const handleOrphan = () => {
    if (stopped) return;
    stopped = true;
    opts.onOrphan();
  };

  const checkPpid = () => {
    if (stopped) return;
    if (isOrphaned(initialPpid)) handleOrphan();
  };

  const timer = setInterval(checkPpid, interval);
  timer.unref();

  process.stdin.resume();
  process.stdin.on("end", handleOrphan);
  process.stdin.on("close", handleOrphan);

  return () => {
    stopped = true;
    clearInterval(timer);
    process.stdin.off("end", handleOrphan);
    process.stdin.off("close", handleOrphan);
  };
}

function isOrphaned(initialPpid: number): boolean {
  const ppid = process.ppid;
  if (ppid !== initialPpid) return true;
  if (ppid === 0 || ppid === 1) return true;
  return false;
}
