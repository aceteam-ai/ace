import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

vi.mock("../../src/utils/python.js", () => ({
  listNodes: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAvailableNodeTypes, validateNodeTypes } from "../../src/utils/node-cache.js";
import { listNodes } from "../../src/utils/python.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockListNodes = vi.mocked(listNodes);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAvailableNodeTypes", () => {
  it("returns cached node types when cache is fresh", async () => {
    const cacheData = {
      timestamp: Date.now() - 1000, // 1 second ago
      nodes: [
        { type: "LLM", display_name: "LLM", description: "AI text generation" },
        { type: "APICall", display_name: "API Call", description: "HTTP calls" },
      ],
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cacheData));

    const result = await getAvailableNodeTypes("/usr/bin/python3");
    expect(result).toBeInstanceOf(Set);
    expect(result!.has("LLM")).toBe(true);
    expect(result!.has("APICall")).toBe(true);
    expect(result!.size).toBe(2);
    // Should NOT have called Python
    expect(mockListNodes).not.toHaveBeenCalled();
  });

  it("fetches from Python when cache is expired", async () => {
    const expiredCache = {
      timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours ago
      nodes: [{ type: "OldNode", display_name: "Old", description: "" }],
    };

    mockExistsSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) return true;
      // For mkdirSync check
      return true;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(expiredCache));
    mockListNodes.mockResolvedValue({
      nodes: [
        { type: "LLM", display_name: "LLM", description: "AI" },
        { type: "Input", display_name: "Input Node", description: "Input" },
      ],
    });

    const result = await getAvailableNodeTypes("/usr/bin/python3");
    expect(result).toBeInstanceOf(Set);
    expect(result!.has("LLM")).toBe(true);
    expect(result!.has("Input")).toBe(true);
    expect(result!.has("OldNode")).toBe(false);
    expect(mockListNodes).toHaveBeenCalledOnce();
    // Should have written new cache
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it("fetches from Python when no cache exists", async () => {
    mockExistsSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) return false;
      return true;
    });
    mockListNodes.mockResolvedValue({
      nodes: [{ type: "LLM", display_name: "LLM", description: "AI" }],
    });

    const result = await getAvailableNodeTypes("/usr/bin/python3");
    expect(result!.has("LLM")).toBe(true);
    expect(mockListNodes).toHaveBeenCalledOnce();
  });

  it("returns null when Python returns error", async () => {
    mockExistsSync.mockReturnValue(false);
    mockListNodes.mockResolvedValue({ error: "Python not found" });

    const result = await getAvailableNodeTypes("/usr/bin/python3");
    expect(result).toBeNull();
  });

  it("returns null when cache is corrupt", async () => {
    mockExistsSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue("not valid json{{{");
    mockListNodes.mockResolvedValue({ error: "fail" });

    const result = await getAvailableNodeTypes("/usr/bin/python3");
    expect(result).toBeNull();
  });
});

describe("validateNodeTypes", () => {
  it("returns empty invalid array when all types are valid", async () => {
    const workflow = {
      inner_nodes: [
        { id: "a", type: "LLM" },
        { id: "b", type: "APICall" },
      ],
    };
    mockReadFileSync.mockReturnValue(JSON.stringify(workflow));

    // Set up fresh cache
    const cacheData = {
      timestamp: Date.now(),
      nodes: [
        { type: "LLM", display_name: "LLM", description: "" },
        { type: "APICall", display_name: "API Call", description: "" },
        { type: "Input", display_name: "Input", description: "" },
      ],
    };
    mockExistsSync.mockReturnValue(true);
    // First call for cache check, second for workflow read
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify(workflow))
      .mockReturnValueOnce(JSON.stringify(cacheData));

    // We need to re-mock since the first readFileSync is for the workflow file
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) {
        return JSON.stringify(cacheData);
      }
      return JSON.stringify(workflow);
    });

    const result = await validateNodeTypes("/usr/bin/python3", "/workflow.json");
    expect(result.invalid).toEqual([]);
  });

  it("reports invalid node types", async () => {
    const workflow = {
      inner_nodes: [
        { id: "a", type: "LLM" },
        { id: "b", type: "PDFParser" },
        { id: "c", type: "FakeNode" },
      ],
    };

    const cacheData = {
      timestamp: Date.now(),
      nodes: [
        { type: "LLM", display_name: "LLM", description: "" },
        { type: "APICall", display_name: "API Call", description: "" },
      ],
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) {
        return JSON.stringify(cacheData);
      }
      return JSON.stringify(workflow);
    });

    const result = await validateNodeTypes("/usr/bin/python3", "/workflow.json");
    expect(result.invalid).toContain("PDFParser");
    expect(result.invalid).toContain("FakeNode");
    expect(result.invalid).not.toContain("LLM");
    expect(result.available).toContain("APICall");
    expect(result.available).toContain("LLM");
  });

  it("deduplicates invalid node types", async () => {
    const workflow = {
      inner_nodes: [
        { id: "a", type: "FakeNode" },
        { id: "b", type: "FakeNode" },
      ],
    };

    const cacheData = {
      timestamp: Date.now(),
      nodes: [{ type: "LLM", display_name: "LLM", description: "" }],
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) {
        return JSON.stringify(cacheData);
      }
      return JSON.stringify(workflow);
    });

    const result = await validateNodeTypes("/usr/bin/python3", "/workflow.json");
    expect(result.invalid).toEqual(["FakeNode"]);
  });

  it("supports v1 schema (nodes array)", async () => {
    const workflow = {
      nodes: [
        { id: "a", type: "LLM" },
        { id: "b", type: "FakeNode" },
      ],
    };

    const cacheData = {
      timestamp: Date.now(),
      nodes: [{ type: "LLM", display_name: "LLM", description: "" }],
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) {
        return JSON.stringify(cacheData);
      }
      return JSON.stringify(workflow);
    });

    const result = await validateNodeTypes("/usr/bin/python3", "/workflow.json");
    expect(result.invalid).toEqual(["FakeNode"]);
  });

  it("skips validation when node list unavailable", async () => {
    const workflow = {
      inner_nodes: [{ id: "a", type: "anything" }],
    };

    mockExistsSync.mockImplementation((path) => {
      if (String(path).includes("node-types.json")) return false;
      return true;
    });
    mockReadFileSync.mockReturnValue(JSON.stringify(workflow));
    mockListNodes.mockResolvedValue({ error: "Python not found" });

    const result = await validateNodeTypes("/usr/bin/python3", "/workflow.json");
    expect(result.invalid).toEqual([]);
    expect(result.available).toEqual([]);
  });

  it("returns empty when workflow has no nodes", async () => {
    const workflow = { edges: [] };
    mockReadFileSync.mockReturnValue(JSON.stringify(workflow));

    const result = await validateNodeTypes("/usr/bin/python3", "/workflow.json");
    expect(result.invalid).toEqual([]);
  });
});
