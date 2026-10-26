import { afterEach, expect, it, vi } from "vitest";

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = 0;
  vi.restoreAllMocks();
});

it("reports a missing nested command argument as JSON with exit code 2", async () => {
  process.argv = ["node", "ace", "org", "use", "--json"];
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { main } = await import("../../src/index.js");
  await main(process.argv);

  expect(process.exitCode).toBe(2);
  expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual({
    error: { code: 2, message: expect.stringContaining("missing required argument") },
  });
});
