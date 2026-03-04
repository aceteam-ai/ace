import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// Mock dependencies
vi.mock("../../src/utils/ensure-python.js", () => ({
  ensurePython: vi.fn(() => Promise.resolve("/usr/bin/python3")),
}));

vi.mock("../../src/utils/python.js", () => ({
  runWorkflow: vi.fn(() =>
    Promise.resolve({
      success: true,
      output: { response: "Mock response" },
    })
  ),
}));

vi.mock("../../src/utils/errors.js", () => ({
  classifyPythonError: vi.fn((msg: string) => ({ message: msg })),
  classifyWorkflowError: vi.fn((result: { error?: string }) => ({
    message: result.error || "Unknown error",
  })),
}));

vi.mock("ora", () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: "",
  })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
  };
});

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: vi.fn(() => ({ default_model: "gpt-4o-mini" })),
}));

vi.mock("../../src/utils/fabric.js", () => ({
  FabricClient: vi.fn(),
}));

vi.mock("../../src/utils/node-cache.js", () => ({
  validateNodeTypes: vi.fn(() =>
    Promise.resolve({ invalid: [], available: [] })
  ),
}));

import { runCommand } from "../../src/commands/run.js";

describe("runCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a Commander command named 'run'", () => {
    expect(runCommand).toBeInstanceOf(Command);
    expect(runCommand.name()).toBe("run");
  });

  it("has expected options", () => {
    const optionNames = runCommand.options.map((o) => o.long);
    expect(optionNames).toContain("--list");
    expect(optionNames).toContain("--info");
    expect(optionNames).toContain("--model");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--verbose");
    expect(optionNames).toContain("--file");
    expect(optionNames).toContain("--input-dir");
    expect(optionNames).toContain("--output");
    expect(optionNames).toContain("--output-dir");
    expect(optionNames).toContain("--input");
    expect(optionNames).toContain("--config");
    expect(optionNames).toContain("--remote");
  });

  it("describes both tasks and workflows", () => {
    const commandStr = runCommand.description();
    expect(commandStr).toBeDefined();
    expect(commandStr).toContain("task");
    expect(commandStr).toContain("workflow");
  });
});
