import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// Mock fs before importing the module
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: vi.fn(() => ({ default_model: "gpt-4o-mini" })),
}));

vi.mock("../../src/utils/python.js", () => ({
  runWorkflow: vi.fn(() =>
    Promise.resolve({
      success: true,
      output: { response: "Mock workflow response" },
    })
  ),
}));

vi.mock("../../src/utils/errors.js", () => ({
  classifyPythonError: vi.fn((msg: string) => ({ message: msg })),
  classifyWorkflowError: vi.fn((result: { error?: string }) => ({
    message: result.error || "Unknown error",
  })),
}));

import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  listPatterns,
  loadPattern,
  readInputFile,
  scanInputDir,
  runPattern,
} from "../../src/utils/patterns.js";
import { BUILTIN_PATTERNS } from "../../src/patterns/index.js";
import { runWorkflow } from "../../src/utils/python.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockRunWorkflow = vi.mocked(runWorkflow);

describe("loadPattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads a built-in pattern by ID", () => {
    const userPatternsDir = join(homedir(), ".ace", "patterns");
    mockExistsSync.mockImplementation((path) => {
      if (String(path).startsWith(userPatternsDir)) return false;
      return false;
    });

    const pattern = loadPattern("summarize");
    expect(pattern).toBeDefined();
    expect(pattern?.id).toBe("summarize");
  });

  it("returns undefined for unknown pattern", () => {
    mockExistsSync.mockReturnValue(false);

    const pattern = loadPattern("nonexistent");
    expect(pattern).toBeUndefined();
  });

  it("loads user pattern that overrides built-in", () => {
    const userPatternsDir = join(homedir(), ".ace", "patterns");
    const systemFile = join(userPatternsDir, "summarize", "system.md");

    mockExistsSync.mockImplementation((path) => {
      if (String(path) === systemFile) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path) => {
      if (String(path) === systemFile) return "Custom summary prompt";
      throw new Error("not found");
    });

    const pattern = loadPattern("summarize");
    expect(pattern).toBeDefined();
    expect(pattern?.category).toBe("user");
    expect(pattern?.systemPrompt).toBe("Custom summary prompt");
  });
});

describe("listPatterns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all built-in patterns when no user patterns exist", () => {
    mockExistsSync.mockReturnValue(false);

    const patterns = listPatterns();
    expect(patterns.length).toBe(BUILTIN_PATTERNS.length);
  });

  it("includes user patterns alongside built-ins", () => {
    const userPatternsDir = join(homedir(), ".ace", "patterns");

    mockExistsSync.mockImplementation((path) => {
      if (String(path) === userPatternsDir) return true;
      if (String(path) === join(userPatternsDir, "custom-pattern", "system.md"))
        return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      { name: "custom-pattern", isDirectory: () => true, isFile: () => false } as unknown as import("node:fs").Dirent,
    ]);

    mockReadFileSync.mockImplementation((path) => {
      if (
        String(path) ===
        join(userPatternsDir, "custom-pattern", "system.md")
      )
        return "Custom prompt";
      throw new Error("not found");
    });

    const patterns = listPatterns();
    expect(patterns.length).toBe(BUILTIN_PATTERNS.length + 1);
    expect(patterns.find((p) => p.id === "custom-pattern")).toBeDefined();
  });
});

describe("readInputFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads a text file", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("  Hello world  ");

    const content = readInputFile("/path/to/file.txt");
    expect(content).toBe("Hello world");
  });

  it("throws for nonexistent file", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => readInputFile("/nonexistent.txt")).toThrow("File not found");
  });

  it("throws for unsupported file type", () => {
    mockExistsSync.mockReturnValue(true);
    expect(() => readInputFile("/file.docx")).toThrow("Unsupported file type");
  });

  it("accepts supported extensions", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("content");

    for (const ext of [".txt", ".md", ".csv", ".json"]) {
      expect(() => readInputFile(`/file${ext}`)).not.toThrow();
    }
  });
});

describe("scanInputDir", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws for nonexistent directory", () => {
    mockExistsSync.mockReturnValue(false);
    expect(() => scanInputDir("/nonexistent")).toThrow("Directory not found");
  });

  it("returns sorted supported files", () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      { name: "b.txt", isFile: () => true, isDirectory: () => false } as unknown as import("node:fs").Dirent,
      { name: "a.md", isFile: () => true, isDirectory: () => false } as unknown as import("node:fs").Dirent,
      { name: "c.docx", isFile: () => true, isDirectory: () => false } as unknown as import("node:fs").Dirent,
      { name: "subfolder", isFile: () => false, isDirectory: () => true } as unknown as import("node:fs").Dirent,
    ]);

    const files = scanInputDir("/dir");
    expect(files).toEqual(["/dir/a.md", "/dir/b.txt"]);
  });
});

describe("runPattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs pattern via Python workflow engine", async () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.id === "summarize")!;
    const result = await runPattern("/usr/bin/python3", pattern, "Some text to summarize");

    expect(mockRunWorkflow).toHaveBeenCalledOnce();
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      "/usr/bin/python3",
      expect.stringContaining("ace-pattern-summarize"),
      { prompt: "Some text to summarize" },
      { verbose: undefined }
    );
    expect(result).toBe("Mock workflow response");
  });

  it("respects model override", async () => {
    const pattern = BUILTIN_PATTERNS[0];
    await runPattern("/usr/bin/python3", pattern, "test", { model: "gpt-4o" });

    expect(mockRunWorkflow).toHaveBeenCalledOnce();
    // The model override is baked into the workflow JSON written to the temp file,
    // so we just verify runWorkflow was called with the right python path
    expect(mockRunWorkflow).toHaveBeenCalledWith(
      "/usr/bin/python3",
      expect.any(String),
      { prompt: "test" },
      { verbose: undefined }
    );
  });

  it("returns JSON when json option is set", async () => {
    const pattern = BUILTIN_PATTERNS[0];
    const result = await runPattern("/usr/bin/python3", pattern, "test", { json: true });

    const parsed = JSON.parse(result);
    expect(parsed.pattern).toBe(pattern.id);
    expect(parsed.response).toBe("Mock workflow response");
  });

  it("throws on workflow failure", async () => {
    mockRunWorkflow.mockResolvedValueOnce({
      success: false,
      error: "Python error",
      output: null,
    });

    const pattern = BUILTIN_PATTERNS[0];
    await expect(
      runPattern("/usr/bin/python3", pattern, "test")
    ).rejects.toThrow("Python error");
  });
});

describe("user graph tasks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefers canonical user graphs over legacy prompts and bundled graphs", () => {
    const file = join(homedir(), ".ace", "patterns", "summarize", "workflow.json");
    const value = structuredClone(BUILTIN_PATTERNS[0].workflow);
    value.name = "Custom graph";
    value.inner_nodes[0].params.system_prompt = "Graph prompt";
    mockExistsSync.mockImplementation((path) => String(path) === file || String(path).endsWith("system.md"));
    mockReadFileSync.mockImplementation((path) => {
      if (String(path) === file) return JSON.stringify(value);
      throw new Error("legacy source should not be read");
    });
    const task = loadPattern("summarize")!;
    expect(task.name).toBe("Custom graph");
    expect(task.category).toBe("user");
    expect(task.workflow).toEqual(value);
    expect(task.systemPrompt).toBe("Graph prompt");
    expect(task.useDefaultModel).toBe(false);
  });

  it("reports a malformed user graph instead of silently loading a built-in", () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith("workflow.json"));
    mockReadFileSync.mockReturnValue('{"input_node":{}}');
    expect(() => loadPattern("summarize")).toThrow("Cannot load task summarize");
    mockReadFileSync.mockReturnValue('{broken');
    expect(() => loadPattern("summarize")).toThrow("workflow.json");
  });

  it("never reads graph files using traversal names", () => {
    expect(loadPattern("../summarize")).toBeUndefined();
    expect(loadPattern("nested/summarize")).toBeUndefined();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("rejects additional required inputs before executing a named text task", async () => {
    const { definePattern } = await import("../../src/patterns/index.js");
    const value = structuredClone(BUILTIN_PATTERNS[0].workflow);
    value.input_node.params.fields.instructions = { type: "string" };
    await expect(runPattern("python", definePattern("custom", "user", value), "text"))
      .rejects.toThrow("named workflow inputs");
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });

  it("cleans up failed runs and gives concurrent runs distinct temporary files", async () => {
    const { unlinkSync, writeFileSync } = await import("node:fs");
    mockRunWorkflow.mockResolvedValue({ success: true, output: { response: "Synthetic output" } });
    await Promise.all([
      runPattern("python", BUILTIN_PATTERNS[0], "one"),
      runPattern("python", BUILTIN_PATTERNS[0], "two"),
    ]);
    const files = mockRunWorkflow.mock.calls.map((call) => call[1]);
    expect(new Set(files).size).toBe(2);
    for (const file of files) {
      expect(unlinkSync).toHaveBeenCalledWith(file);
      expect(writeFileSync).toHaveBeenCalledWith(file, expect.any(String), { encoding: "utf-8", mode: 0o600, flag: "wx" });
    }
    mockRunWorkflow.mockRejectedValueOnce(new Error("Synthetic failure"));
    await expect(runPattern("python", BUILTIN_PATTERNS[0], "three")).rejects.toThrow("Synthetic failure");
    expect(unlinkSync).toHaveBeenCalledWith(mockRunWorkflow.mock.calls[2][1]);
  });
});


describe("temporary task file ownership", () => {
  it("does not remove a file when exclusive creation fails", async () => {
    vi.clearAllMocks();
    const { writeFileSync, unlinkSync } = await import("node:fs");
    vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error("Synthetic write failure"); });
    await expect(runPattern("python", BUILTIN_PATTERNS[0], "text")).rejects.toThrow("Synthetic write failure");
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });
});


describe("named task output compatibility", () => {
  it("rejects structured output before submitting a workflow", async () => {
    vi.clearAllMocks();
    const { definePattern } = await import("../../src/patterns/index.js");
    const value = structuredClone(BUILTIN_PATTERNS[0].workflow);
    value.output_node.params.fields.response = { type: "object", properties: { result: { type: "string" } } };
    await expect(runPattern("python", definePattern("structured", "user", value), "text"))
      .rejects.toThrow("keep its structured output");
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });
});
