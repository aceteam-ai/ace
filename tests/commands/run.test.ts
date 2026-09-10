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

import { resolveFreeTextAlias, runCommand } from "../../src/commands/run.js";

describe("runCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });


  it("keeps multi-word JSON paths in workflow mode", () => {
    expect(resolveFreeTextAlias("/tmp/my workflow.json", undefined, false)).toEqual({
      target: "/tmp/my workflow.json",
      inlineText: undefined,
    });
  });

  it("maps unambiguous multi-word text to the default summarize task", () => {
    expect(resolveFreeTextAlias("explain this sentence", undefined, false)).toEqual({
      target: "summarize",
      inlineText: "explain this sentence",
    });
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

describe("named graph input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects --remote named tasks before starting local execution", async () => {
    const { ensurePython } = await import("../../src/utils/ensure-python.js");
    const { runWorkflow } = await import("../../src/utils/python.js");
    const { loadConfig } = await import("../../src/utils/config.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      await runCommand.parseAsync([
        "node",
        "ace",
        "summarize",
        "Synthetic text",
        "--remote",
      ]);

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("workflow .json files")
      );
      expect(ensurePython).not.toHaveBeenCalled();
      expect(loadConfig).not.toHaveBeenCalled();
      expect(runWorkflow).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      runCommand.setOptionValue("remote", undefined);
      write.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects required named inputs before bootstrapping Python", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { ensurePython } = await import("../../src/utils/ensure-python.js");
    const { BUILTIN_PATTERNS } = await import("../../src/patterns/index.js");
    const graph = structuredClone(BUILTIN_PATTERNS[0].workflow);
    graph.input_node.params.fields.extra = { type: "string" };
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("workflow.json"));
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(graph));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      await runCommand.parseAsync(["node", "ace", "summarize", "Synthetic text"]);
      expect(ensurePython).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("named workflow inputs"));
    } finally {
      process.exitCode = previousExitCode;
      error.mockRestore();
    }
  });
});
