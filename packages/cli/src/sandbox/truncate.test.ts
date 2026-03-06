import { describe, test, expect } from 'bun:test';
import { smartTruncate, truncateMiddle, truncateArray } from './truncate';

describe('smartTruncate', () => {
  test('returns original for small values', () => {
    const result = smartTruncate('short string');
    expect(result).toBe('short string');
  });

  test('truncates long strings', () => {
    const longString = 'x'.repeat(30000);
    const result = smartTruncate(longString, { maxLength: 1000 });

    expect(result.length).toBeLessThan(longString.length);
  });

  test('uses 60/40 head/tail split', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join('\n');

    const result = smartTruncate(text, { maxLength: 500 });

    // Should contain head content
    expect(result).toContain('Line 1');
    // Should contain tail content
    expect(result).toContain('Line 100');
    // Should have truncation marker
    expect(result).toContain('truncated');
  });

  test('respects headRatio option', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join('\n');

    // With headRatio 0.8, should keep more head content
    const result = smartTruncate(text, { maxLength: 500, headRatio: 0.8 });
    expect(result).toContain('Line 1');
  });
});

describe('truncateMiddle', () => {
  test('returns original if under limit', () => {
    const result = truncateMiddle('short', 100);
    expect(result).toBe('short');
  });

  test('truncates long strings with marker', () => {
    const longString = 'a'.repeat(200);
    const result = truncateMiddle(longString, 100);

    expect(result.length).toBeLessThan(longString.length);
    expect(result).toContain('...');
  });

  test('preserves start and end of string', () => {
    const text = 'START_' + 'x'.repeat(200) + '_END';
    const result = truncateMiddle(text, 100);

    expect(result).toContain('START');
    expect(result).toContain('END');
  });
});

describe('truncateArray', () => {
  test('returns original if under limit', () => {
    const arr = [1, 2, 3];
    const result = truncateArray(arr, 10);

    expect(result).toEqual([1, 2, 3]);
  });

  test('truncates long arrays', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = truncateArray(arr, 10);

    expect(result.length).toBeLessThanOrEqual(11); // 10 items + marker
  });

  test('includes truncation marker object', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = truncateArray(arr, 10);

    const hasMarker = result.some(
      item => typeof item === 'object' && item !== null && '__truncated__' in item
    );
    expect(hasMarker).toBe(true);
  });

  test('preserves head and tail items', () => {
    const arr = Array.from({ length: 100 }, (_, i) => `item_${i}`);
    const result = truncateArray(arr, 10);

    expect(result[0]).toBe('item_0');
    expect(result[result.length - 1]).toBe('item_99');
  });
});
