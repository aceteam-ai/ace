import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../src/utils/retry.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on network error and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });

    // Advance past the first retry delay
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 status code errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Fabric API error (429): Too Many Requests"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on 502/503/504 status codes", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Fabric API error (502): Bad Gateway"))
      .mockRejectedValueOnce(new Error("Fabric API error (503): Service Unavailable"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after max retries exhausted", async () => {
    vi.useRealTimers(); // Use real timers to avoid unhandled rejection timing issues

    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 20 })
    ).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries

    vi.useFakeTimers(); // Restore for afterEach
  });

  it("does not retry on non-retryable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Fabric API error (403): Forbidden"));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 100 })
    ).rejects.toThrow("403");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects custom shouldRetry predicate", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("custom-retryable"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      shouldRetry: (err) =>
        err instanceof Error && err.message.includes("custom-retryable"),
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies exponential backoff with delay growth", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue("ok");

    // baseDelay=100: attempt 0 delay = 100ms, attempt 1 delay = 200ms (+ jitter)
    const promise = withRetry(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10000 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
