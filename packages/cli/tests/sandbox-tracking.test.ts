/**
 * Sandbox I/O Tracking Tests
 *
 * Tests for FS/Network byte tracking in sandbox execution.
 * Tests for FS/Network byte tracking in sandbox execution.
 */

import { describe, it, expect, beforeEach } from "bun:test";

// ============================================================================
// Mock SessionStats (mirrors context/tracking.ts)
// ============================================================================

interface SessionStats {
  fsBytesRead: number;
  fsFilesRead: number;
  networkBytesIn: number;
  networkRequests: number;
  totalChars: number;
  totalCalls: number;
}

let sessionStats: SessionStats;

function resetStats(): void {
  sessionStats = {
    fsBytesRead: 0,
    fsFilesRead: 0,
    networkBytesIn: 0,
    networkRequests: 0,
    totalChars: 0,
    totalCalls: 0,
  };
}

function trackSandboxIO(tracking?: {
  fsBytes?: number;
  fsCount?: number;
  netBytes?: number;
  netCount?: number;
}): void {
  if (!tracking) return;
  sessionStats.fsBytesRead += tracking.fsBytes ?? 0;
  sessionStats.fsFilesRead += tracking.fsCount ?? 0;
  sessionStats.networkBytesIn += tracking.netBytes ?? 0;
  sessionStats.networkRequests += tracking.netCount ?? 0;
}

function trackFsBytes(bytes: number): void {
  sessionStats.fsBytesRead += bytes;
  sessionStats.fsFilesRead++;
}

function trackNetworkBytes(bytesIn: number): void {
  sessionStats.networkBytesIn += bytesIn;
  sessionStats.networkRequests++;
}

// ============================================================================
// Tests
// ============================================================================

describe("Sandbox I/O Tracking", () => {
  beforeEach(() => {
    resetStats();
  });

  describe("trackSandboxIO", () => {
    it("tracks FS bytes from sandbox execution", () => {
      trackSandboxIO({ fsBytes: 50000, fsCount: 3 });

      expect(sessionStats.fsBytesRead).toBe(50000);
      expect(sessionStats.fsFilesRead).toBe(3);
    });

    it("tracks network bytes from sandbox execution", () => {
      trackSandboxIO({ netBytes: 25000, netCount: 2 });

      expect(sessionStats.networkBytesIn).toBe(25000);
      expect(sessionStats.networkRequests).toBe(2);
    });

    it("accumulates across multiple calls", () => {
      trackSandboxIO({ fsBytes: 10000, fsCount: 1 });
      trackSandboxIO({ fsBytes: 20000, fsCount: 2 });
      trackSandboxIO({ netBytes: 5000, netCount: 1 });

      expect(sessionStats.fsBytesRead).toBe(30000);
      expect(sessionStats.fsFilesRead).toBe(3);
      expect(sessionStats.networkBytesIn).toBe(5000);
    });

    it("handles undefined tracking gracefully", () => {
      trackSandboxIO(undefined);

      expect(sessionStats.fsBytesRead).toBe(0);
      expect(sessionStats.networkBytesIn).toBe(0);
    });

    it("handles partial tracking data", () => {
      trackSandboxIO({ fsBytes: 1000 });

      expect(sessionStats.fsBytesRead).toBe(1000);
      expect(sessionStats.fsFilesRead).toBe(0);
    });
  });

  describe("trackFsBytes (for mcx_file)", () => {
    it("tracks bytes when reading a file", () => {
      // Simulates mcx_file reading a 50KB file
      trackFsBytes(50000);

      expect(sessionStats.fsBytesRead).toBe(50000);
      expect(sessionStats.fsFilesRead).toBe(1);
    });

    it("accumulates across multiple file reads", () => {
      trackFsBytes(10000); // file 1
      trackFsBytes(20000); // file 2
      trackFsBytes(30000); // file 3

      expect(sessionStats.fsBytesRead).toBe(60000);
      expect(sessionStats.fsFilesRead).toBe(3);
    });
  });

  describe("trackNetworkBytes (for mcx_fetch)", () => {
    it("tracks bytes from network requests", () => {
      trackNetworkBytes(100000);

      expect(sessionStats.networkBytesIn).toBe(100000);
      expect(sessionStats.networkRequests).toBe(1);
    });
  });

  describe("Combined Tracking", () => {
    it("tracks both FS and network in same session", () => {
      // Read 3 files
      trackFsBytes(30000);
      trackFsBytes(20000);
      trackFsBytes(50000);

      // Fetch 2 URLs
      trackNetworkBytes(80000);
      trackNetworkBytes(40000);

      expect(sessionStats.fsBytesRead).toBe(100000);
      expect(sessionStats.fsFilesRead).toBe(3);
      expect(sessionStats.networkBytesIn).toBe(120000);
      expect(sessionStats.networkRequests).toBe(2);

      // Total kept in sandbox
      const keptOut = sessionStats.fsBytesRead + sessionStats.networkBytesIn;
      expect(keptOut).toBe(220000);
    });
  });

  describe("Real-world Scenarios", () => {
    it("typical code exploration session", () => {
      // User reads several source files
      trackFsBytes(51000);  // serve.ts (51KB)
      trackFsBytes(18000);  // execute.ts (18KB)
      trackFsBytes(15000);  // tracking.ts (15KB)
      trackFsBytes(13000);  // stats.ts (13KB)

      expect(sessionStats.fsBytesRead).toBe(97000);
      expect(sessionStats.fsFilesRead).toBe(4);

      // With typical 5KB of responses sent to model
      const toModel = 5000;
      const keptOut = sessionStats.fsBytesRead;
      const reductionPct = Math.round((keptOut / (keptOut + toModel)) * 100);

      expect(reductionPct).toBe(95);
    });

    it("API documentation fetch session", () => {
      // Fetch several API docs
      trackNetworkBytes(150000);  // API reference
      trackNetworkBytes(80000);   // Examples page
      trackNetworkBytes(50000);   // SDK docs

      expect(sessionStats.networkBytesIn).toBe(280000);

      // With 10KB summary sent to model
      const toModel = 10000;
      const keptOut = sessionStats.networkBytesIn;
      const reductionPct = Math.round((keptOut / (keptOut + toModel)) * 100);

      expect(reductionPct).toBe(97);
    });
  });
});
