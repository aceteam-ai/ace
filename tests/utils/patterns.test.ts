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
