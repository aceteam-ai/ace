import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensurePython: vi.fn(async () => "/managed/python"),
  validatePatternInput: vi.fn(),
  runPattern: vi.fn(async () => "result"),
  pattern: { id: "rich", name: "Rich", description: "Rich graph", category: "user", workflow: {} },
}));
vi.mock("../../src/utils/ensure-python.js", () => ({ ensurePython: mocks.ensurePython }));
vi.mock("../../src/utils/patterns.js", () => ({
  listPatterns: () => [mocks.pattern], loadPattern: () => mocks.pattern,
  validatePatternInput: mocks.validatePatternInput, runPattern: mocks.runPattern,
}));
vi.mock("../../src/utils/config.js", () => ({ loadConfig: () => ({}), saveConfig: vi.fn() }));
vi.mock("../../src/utils/provider-detect.js", () => ({ detectProvider: async () => ({ provider: null }) }));
vi.mock("../../src/utils/node-cache.js", () => ({ validateNodeTypes: async () => ({ invalid: [], available: [] }) }));
vi.mock("../../src/utils/python.js", () => ({ runWorkflow: vi.fn(), ProgressEvent: {} }));

import { taskService } from "../../src/ui/task-service.js";

beforeEach(() => vi.clearAllMocks());

describe("workspace task service", () => {
  it("rejects unsupported named-task facades before preparing Python", async () => {
    mocks.validatePatternInput.mockImplementationOnce(() => { throw new Error("requires named workflow inputs"); });
    await expect(taskService.executePattern("rich", "text", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).rejects.toThrow("requires named workflow inputs");
    expect(mocks.ensurePython).not.toHaveBeenCalled();
    expect(mocks.runPattern).not.toHaveBeenCalled();
  });

  it("prepares Python only after facade validation succeeds", async () => {
    await expect(taskService.executePattern("rich", "text", {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    })).resolves.toBe("result");
    expect(mocks.validatePatternInput).toHaveBeenCalledBefore(mocks.ensurePython);
  });
});
