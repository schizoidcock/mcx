/**
 * Context Efficiency Tests
 *
 * Tests for context savings computation.
 * Tests for context savings computation.
 */

import { describe, it, expect } from "bun:test";

// ============================================================================
// Helpers (mirror the calculation in stats.ts)
// ============================================================================

interface ContextSavings {
  keptOut: number;
  totalProcessed: number;
  toModel: number;
  reductionPct: number;
}

function computeContextSavings(
  fsBytesRead: number,
  networkBytesIn: number,
  totalChars: number
): ContextSavings {
  const keptOut = fsBytesRead + networkBytesIn;
  const totalProcessed = keptOut + totalChars;
  const reductionPct = totalProcessed > 0
    ? Math.round((keptOut / totalProcessed) * 100)
    : 0;

  return { keptOut, totalProcessed, toModel: totalChars, reductionPct };
}

// ============================================================================
// Tests
// ============================================================================

describe("Context Efficiency", () => {
  describe("computeContextSavings", () => {
    it("computes 95% reduction when most data stays in sandbox", () => {
      // 100KB read, 5KB sent to model
      const savings = computeContextSavings(100_000, 0, 5_000);

      expect(savings.keptOut).toBe(100_000);
      expect(savings.totalProcessed).toBe(105_000);
      expect(savings.toModel).toBe(5_000);
      expect(savings.reductionPct).toBe(95);
    });

    it("computes 99% reduction for large file reads", () => {
      // 1MB read, only 10KB sent
      const savings = computeContextSavings(1_000_000, 0, 10_000);

      expect(savings.reductionPct).toBe(99);
    });

    it("includes network bytes in calculation", () => {
      // 50KB from FS, 50KB from network, 10KB sent
      const savings = computeContextSavings(50_000, 50_000, 10_000);

      expect(savings.keptOut).toBe(100_000);
      expect(savings.totalProcessed).toBe(110_000);
      expect(savings.reductionPct).toBe(91);
    });

    it("handles 0% reduction when no sandbox data", () => {
      // No FS/network reads, just tool responses
      const savings = computeContextSavings(0, 0, 5_000);

      expect(savings.keptOut).toBe(0);
      expect(savings.reductionPct).toBe(0);
    });

    it("handles edge case with no data at all", () => {
      const savings = computeContextSavings(0, 0, 0);

      expect(savings.reductionPct).toBe(0);
      expect(savings.totalProcessed).toBe(0);
    });

    it("handles 100% reduction (nothing sent to model)", () => {
      // File read but only confirmation message sent
      const savings = computeContextSavings(100_000, 0, 0);

      expect(savings.reductionPct).toBe(100);
    });
  });

  describe("Token Estimation", () => {
    it("estimates tokens at ~4 bytes per token", () => {
      const bytes = 80_000;
      const tokens = Math.round(bytes / 4);

      expect(tokens).toBe(20_000);
    });

    it("estimates context percentage correctly", () => {
      const tokensPreserved = 20_000;
      const contextWindow = 200_000;
      const pctPreserved = (tokensPreserved / contextWindow) * 100;

      expect(pctPreserved).toBe(10);
    });

    it("estimates cost savings (Opus pricing)", () => {
      const tokensSaved = 100_000;
      const costPerMillionTokens = 5; // $5/1M input tokens
      const costSaved = (tokensSaved / 1_000_000) * costPerMillionTokens;

      expect(costSaved).toBe(0.5);
    });
  });

  describe("Real-world Scenarios", () => {
    it("typical mcx_file read scenario", () => {
      // User reads 50KB file, gets "✓ Stored $x" (~50 bytes)
      const savings = computeContextSavings(50_000, 0, 50);

      expect(savings.reductionPct).toBe(100); // rounds to 100%
      expect(savings.keptOut).toBe(50_000);
    });

    it("mcx_file with code query", () => {
      // User reads 50KB file, runs lines($x, 1, 50) returns ~2KB
      const savings = computeContextSavings(50_000, 0, 2_000);

      expect(savings.reductionPct).toBe(96);
    });

    it("mcx_grep search scenario", () => {
      // Searches 10 files totaling 500KB, returns 5KB of matches
      const savings = computeContextSavings(500_000, 0, 5_000);

      expect(savings.reductionPct).toBe(99);
    });

    it("mcx_fetch scenario", () => {
      // Fetches 100KB webpage, extracts 3KB of relevant content
      const savings = computeContextSavings(0, 100_000, 3_000);

      expect(savings.reductionPct).toBe(97);
    });

    it("mixed FS and network", () => {
      // Reads 2 files (80KB), fetches API (20KB), returns 8KB summary
      const savings = computeContextSavings(80_000, 20_000, 8_000);

      expect(savings.reductionPct).toBe(93);
    });
  });
});
