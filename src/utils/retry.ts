export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Predicate to decide whether to retry on a given error. Defaults to retrying network/transient errors. */
  shouldRetry?: (error: unknown) => boolean;
}

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/**
 * Default predicate: retry on network errors and transient HTTP status codes.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true; // Network error (fetch failed)
  }

  const message = error instanceof Error ? error.message : String(error);

  // Network errors
  if (
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("EAI_AGAIN") ||
    message.includes("fetch failed")
  ) {
    return true;
  }

  // Retryable HTTP status codes from Fabric API errors
  for (const code of RETRYABLE_STATUS_CODES) {
    if (message.includes(`(${code})`)) {
      return true;
    }
  }

  return false;
}

/**
 * Execute a function with exponential backoff retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    shouldRetry = isRetryableError,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = delay * 0.1 * Math.random();
      await sleep(delay + jitter);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
