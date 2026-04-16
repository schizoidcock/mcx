/**
 * Daemon Types
 *
 * Shared types for the MCX daemon system.
 * ONE source of truth for daemon state.
 */

/** Lock file structure - THE source of truth for daemon state */
export interface DaemonLock {
  pid: number;
  port: number;
  startedAt: number;
}

/** Result of ensureDaemon - always a connection, no special cases */
export interface DaemonConnection {
  port: number;
  isOwner: boolean;
}

/** Health check response from daemon */
export interface DaemonHealth {
  pid: number;
  uptime: number;
  sessions: number;
}
