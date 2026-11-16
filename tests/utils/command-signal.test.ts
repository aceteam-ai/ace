import { describe, expect, it } from "vitest";
import { withCommandSignal } from "../../src/utils/command-signal.js";

describe("withCommandSignal", () => {
  it("aborts an owned operation on SIGINT and removes its listener after teardown", async () => {
    const before = process.listenerCount("SIGINT");
    let observed = false;
    await withCommandSignal(async (signal) => {
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        observed = signal.aborted;
        resolve();
      }, { once: true }));
      process.emit("SIGINT");
      await aborted;
    });
    expect(observed).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
