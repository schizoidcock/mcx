/**
 * Stats Format Tests
 *
 * Tests for mcx_stats output format.
 * Tests for mcx_stats output format.
 *
 * Design rules:
 * 1. Fresh session shows "no sandbox data yet"
 * 2. Active session shows before/after comparison bars
 * 3. Per-tool table shows calls and bytes
 * 4. Output is concise (<20 lines for typical sessions)
 * 5. Hero metric is reduction percentage
 */

import { describe, it, expect } from "bun:test";

// ============================================================================
// Helpers (simulate stats output)
// ============================================================================

interface SessionStats {
  totalCalls: number;
  totalChars: number;
  fsBytesRead: number;
  networkBytesIn: number;
  byTool: Map<string, { calls: number; chars: number }>;
}

function formatContextEfficiency(stats: SessionStats): string[] {
  const lines: string[] = [];
  const keptOut = stats.fsBytesRead + stats.networkBytesIn;
  const totalProcessed = keptOut + stats.totalChars;

  if (totalProcessed === 0) {
    return ["📊 Context Efficiency", "   (no data yet)"];
  }

  const reductionPct = Math.round((keptOut / totalProcessed) * 100);
  const barWidth = 20;

  if (keptOut > 0) {
    const filledKept = Math.round((keptOut / totalProcessed) * barWidth);
    lines.push("📊 Context Efficiency");
    lines.push(`   Processed: |${"█".repeat(barWidth)}| ${formatBytes(totalProcessed)}`);
    lines.push(`   To Model:  |${"█".repeat(barWidth - filledKept)}${"░".repeat(filledKept)}| ${formatBytes(stats.totalChars)} (${100 - reductionPct}%)`);
    lines.push("");
    lines.push(`   🎯 ${formatBytes(keptOut)} kept in sandbox (${reductionPct}% reduction)`);
  } else {
    lines.push("📊 Context Efficiency");
    lines.push(`   ${formatBytes(stats.totalChars)} sent to model (no sandbox data yet)`);
  }

  return lines;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Tests
// ============================================================================

describe("Stats Format", () => {
  describe("Fresh Session", () => {
    it("shows 'no data yet' when no activity", () => {
      const stats: SessionStats = {
        totalCalls: 0,
        totalChars: 0,
        fsBytesRead: 0,
        networkBytesIn: 0,
        byTool: new Map(),
      };

      const output = formatContextEfficiency(stats);

      expect(output).toContain("📊 Context Efficiency");
      expect(output.some(l => l.includes("no data yet"))).toBe(true);
    });

    it("shows 'no sandbox data yet' when only tool responses", () => {
      const stats: SessionStats = {
        totalCalls: 5,
        totalChars: 1000,
        fsBytesRead: 0,
        networkBytesIn: 0,
        byTool: new Map([["stats", { calls: 5, chars: 1000 }]]),
      };

      const output = formatContextEfficiency(stats);

      expect(output.some(l => l.includes("no sandbox data"))).toBe(true);
    });
  });

  describe("Active Session", () => {
    it("shows comparison bars when sandbox has data", () => {
      const stats: SessionStats = {
        totalCalls: 10,
        totalChars: 5000,
        fsBytesRead: 100000,
        networkBytesIn: 0,
        byTool: new Map([["file", { calls: 10, chars: 5000 }]]),
      };

      const output = formatContextEfficiency(stats);

      expect(output.some(l => l.includes("Processed:"))).toBe(true);
      expect(output.some(l => l.includes("To Model:"))).toBe(true);
      expect(output.some(l => l.includes("█"))).toBe(true);
      expect(output.some(l => l.includes("░"))).toBe(true);
    });

    it("shows reduction percentage as hero metric", () => {
      const stats: SessionStats = {
        totalCalls: 3,
        totalChars: 2000,
        fsBytesRead: 50000,
        networkBytesIn: 0,
        byTool: new Map(),
      };

      const output = formatContextEfficiency(stats);

      // 50KB kept, 2KB sent = 96% reduction
      expect(output.some(l => l.includes("96% reduction"))).toBe(true);
    });

    it("shows bytes kept in sandbox", () => {
      const stats: SessionStats = {
        totalCalls: 1,
        totalChars: 100,
        fsBytesRead: 80000,
        networkBytesIn: 0,
        byTool: new Map(),
      };

      const output = formatContextEfficiency(stats);

      expect(output.some(l => l.includes("78.1 KB kept in sandbox"))).toBe(true);
    });
  });

  describe("Output Conciseness", () => {
    it("efficiency section is under 10 lines", () => {
      const stats: SessionStats = {
        totalCalls: 20,
        totalChars: 10000,
        fsBytesRead: 500000,
        networkBytesIn: 50000,
        byTool: new Map([
          ["file", { calls: 10, chars: 5000 }],
          ["grep", { calls: 5, chars: 3000 }],
          ["execute", { calls: 5, chars: 2000 }],
        ]),
      };

      const output = formatContextEfficiency(stats);

      expect(output.length).toBeLessThan(10);
    });
  });

  describe("formatBytes", () => {
    it("formats bytes correctly", () => {
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(50 * 1024)).toBe("50.0 KB");
      expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
      expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
    });
  });
});
