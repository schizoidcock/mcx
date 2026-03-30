/**
 * Retry utilities with exponential backoff and jitter
 */

export interface RetryOptions {
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms (default: 100) */
  baseDelayMs?: number;
  /** Max delay cap in ms (default: 5000) */
  maxDelayMs?: number;
  /** Retry on these status codes (default: [429, 500, 502, 503, 504]) */
  retryStatusCodes?: number[];
  /** Called before each retry with attempt number and delay */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const DEFAULT_RETRY_STATUS_CODES = [429, 500, 502, 503, 504];

/**
 * Calculate jittered exponential backoff delay.
 * Uses "full jitter" strategy: delay = random(0, min(cap, base * 2^attempt))
 */
export function jitterBackoff(attempt: number, baseMs = 100, maxMs = 5000): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * exponential);
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a fetch request with exponential backoff and jitter.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    retryStatusCodes = DEFAULT_RETRY_STATUS_CODES,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(input, init);

      // Check if we should retry based on status code
      if (retryStatusCodes.includes(response.status) && attempt < maxRetries) {
        // Cancel response body to free connection
        await response.body?.cancel();
        const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
        onRetry?.(attempt + 1, delay, new Error(`HTTP ${response.status}`));
        await sleep(delay);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      // Network errors - retry if attempts remaining
      if (attempt < maxRetries) {
        const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
        onRetry?.(attempt + 1, delay, error);
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}

/**
 * Retry any async operation with exponential backoff and jitter.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    onRetry,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries) {
        const delay = jitterBackoff(attempt, baseDelayMs, maxDelayMs);
        onRetry?.(attempt + 1, delay, error);
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError;
}
