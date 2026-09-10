import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformClient } from "../../src/platform/client.js";
import type { PlatformTemplate } from "../../src/platform/types.js";

const mocks = vi.hoisted(() => ({
  ensurePython: vi.fn(async () => "/managed/python"),
  validateNodeTypes: vi.fn(async () => ({ invalid: [] as string[], available: ["Text"] })),
  runWorkflow: vi.fn(async () => ({ success: true, output: { response: "ok" } })),
}));

vi.mock("../../src/utils/ensure-python.js", () => ({ ensurePython: mocks.ensurePython }));
vi.mock("../../src/utils/node-cache.js", () => ({ validateNodeTypes: mocks.validateNodeTypes }));
vi.mock("../../src/utils/python.js", () => ({ runWorkflow: mocks.runWorkflow }));

import { runPlatformTemplateLocally } from "../../src/platform/workflow.js";

const template = {
  workflowId: "11111111-2222-4333-8444-555555555555",
  workflowVersionId: "version-3",
  versionNumber: 3,
  title: "Local",
  graph: {
    input_node: { id: "input", type: "Input", params: { fields: { prompt: { type: "string" }, count: { type: "integer", default: 3 } } } },
    inner_nodes: [{ id: "text", type: "Text", params: { text: "ok" } }],
    output_node: { id: "output", type: "Output", params: { fields: { response: { type: "string" } } } },
    edges: [{ source_id: "text", source_key: "text", target_id: "output", target_key: "response" }],
  },
} as unknown as PlatformTemplate;

const client = { assertAuthorizedTemplate: vi.fn() } as unknown as PlatformClient;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensurePython.mockResolvedValue("/managed/python");
  mocks.validateNodeTypes.mockResolvedValue({ invalid: [], available: ["Text"] });
  mocks.runWorkflow.mockResolvedValue({ success: true, output: { response: "ok" } });
});

describe("authorized platform template local execution", () => {
  it("validates before Python and removes the private graph after success", async () => {
    await expect(runPlatformTemplateLocally(client, template, { prompt: 4 })).rejects.toThrow("prompt expects string");
    expect(mocks.ensurePython).not.toHaveBeenCalled();

    let graphPath = "";
    mocks.runWorkflow.mockImplementationOnce(async (_python, path, input) => {
      graphPath = path;
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(template.graph);
      expect(input).toEqual({ prompt: "hello", count: 3 });
      return { success: true, output: { response: "ok" } };
    });
    await expect(runPlatformTemplateLocally(client, template, { prompt: "hello" })).resolves.toMatchObject({ success: true });
    expect(existsSync(graphPath)).toBe(false);
    expect(existsSync(dirname(graphPath))).toBe(false);
  });

  it("reports local incompatibility without running and still cleans up", async () => {
    let graphPath = "";
    mocks.validateNodeTypes.mockImplementationOnce(async (_python, path) => {
      graphPath = path;
      return { invalid: ["PlatformOnly"], available: ["Text"] };
    });
    await expect(runPlatformTemplateLocally(client, template, { prompt: "hello" })).rejects.toThrow("not compatible with the local runtime");
    expect(mocks.runWorkflow).not.toHaveBeenCalled();
    expect(existsSync(dirname(graphPath))).toBe(false);
  });

  it("removes the graph when cancelled execution rejects", async () => {
    let graphPath = "";
    mocks.runWorkflow.mockImplementationOnce(async (_python, path) => {
      graphPath = path;
      throw new Error("aborted");
    });
    await expect(runPlatformTemplateLocally(client, template, { prompt: "hello" })).rejects.toThrow("aborted");
    expect(existsSync(dirname(graphPath))).toBe(false);
  });
});
