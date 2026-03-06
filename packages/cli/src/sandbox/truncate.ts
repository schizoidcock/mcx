import type { TruncateOptions } from './types.js';

const DEFAULT_MAX_LENGTH = 25000;
const DEFAULT_HEAD_RATIO = 0.6;

/**
 * Smart truncate with 60/40 head/tail split.
 *
 * Why 60/40:
 * - Head (60%): Contains headers, context, initial results
 * - Tail (40%): Contains final results, errors, conclusions
 *
 * This preserves both the setup context and the outcome.
 */
export function smartTruncate(
  raw: string,
  options: TruncateOptions = {}
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO;

  if (raw.length <= maxLength) return raw;

  const lines = raw.split('\n');
  const headBudget = Math.floor(maxLength * headRatio);
  const tailBudget = maxLength - headBudget;

  // Collect head lines
  const headLines: string[] = [];
  let headBytes = 0;
  for (const line of lines) {
    const lineSize = line.length + 1; // +1 for newline
    if (headBytes + lineSize > headBudget) break;
    headLines.push(line);
    headBytes += lineSize;
  }

  // Collect tail lines (from end) - use push then reverse to avoid O(n²) unshift
  const tailLines: string[] = [];
  let tailBytes = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lineSize = lines[i].length + 1;
    if (tailBytes + lineSize > tailBudget) break;
    tailLines.push(lines[i]);
    tailBytes += lineSize;
  }
  tailLines.reverse();

  const skipped = lines.length - headLines.length - tailLines.length;

  if (skipped <= 0) {
    // Edge case: no lines to skip, just return truncated
    return raw.slice(0, maxLength);
  }

  return [
    headLines.join('\n'),
    '',
    `[${skipped} lines truncated]`,
    '',
    tailLines.join('\n'),
  ].join('\n');
}

/**
 * Truncate a string from the middle, preserving start and end.
 * Useful for single-line content like JSON.
 */
export function truncateMiddle(
  str: string,
  maxLength: number,
  headRatio = DEFAULT_HEAD_RATIO
): string {
  if (str.length <= maxLength) return str;

  const headLen = Math.floor(maxLength * headRatio);
  const tailLen = maxLength - headLen - 20; // Reserve space for marker

  if (tailLen <= 0) {
    return str.slice(0, maxLength - 3) + '...';
  }

  const skipped = str.length - headLen - tailLen;
  return `${str.slice(0, headLen)}...[${skipped} chars]...${str.slice(-tailLen)}`;
}

/**
 * Truncate arrays by keeping first and last items.
 * Returns [first N items, marker, last M items].
 */
export function truncateArray<T>(
  arr: T[],
  maxItems: number,
  headRatio = DEFAULT_HEAD_RATIO
): T[] {
  if (arr.length <= maxItems) return arr;

  const headCount = Math.floor(maxItems * headRatio);
  const tailCount = maxItems - headCount;

  const head = arr.slice(0, headCount);
  const tail = arr.slice(-tailCount);
  const skipped = arr.length - headCount - tailCount;

  // Insert marker as a special item
  return [
    ...head,
    { __truncated__: true, skipped } as unknown as T,
    ...tail,
  ];
}
