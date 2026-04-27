/**
 * Warnings - Runtime warnings and notifications
 * ONE source of truth for warning messages
 */

export const warnings = {
  outputTruncated: (limit: string) =>
    `⚠️ Output truncated (${limit} limit)`,

  largeArray: (count: number, sizeKB: number, suggestions: string[]) =>
    `⚠️ Large array (${count} items, ${sizeKB}KB). Try:\n` +
    suggestions.slice(0, 3).map(s => `   • ${s}`).join('\n'),

  largeObject: (keyCount: number, sizeKB: number, suggestions: string[]) =>
    `⚠️ Large object (${keyCount} keys, ${sizeKB}KB). Try:\n` +
    suggestions.map(s => `   • ${s}`).join('\n'),

  retryLoop: (count: number, lastError: string) =>
    `⚠️ This code failed ${count}x recently. Last: ${lastError.slice(0, 100)}`,

  searchThrottled: (calls: number) =>
    `Search throttled (${calls} calls in window). Wait a moment.`,
};
