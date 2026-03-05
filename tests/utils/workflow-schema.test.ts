import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/config.js", () => ({
  loadConfig: vi.fn(() => ({ default_model: "gpt-4o-mini" })),
}));

import { patternToWorkflow } from "../../src/utils/patterns.js";
import { BUILTIN_PATTERNS } from "../../src/patterns/index.js";

describe("patternToWorkflow — v2 schema", () => {
  it("generates valid v2 structure with input_node, output_node, inner_nodes, edges", () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.id === "summarize")!;
    const workflow = patternToWorkflow(pattern);

    expect(workflow).toHaveProperty("input_node");
    expect(workflow).toHaveProperty("output_node");
    expect(workflow).toHaveProperty("inner_nodes");
    expect(workflow).toHaveProperty("edges");

    // Should NOT have v1 fields
    expect(workflow).not.toHaveProperty("nodes");
    expect(workflow).not.toHaveProperty("inputs");
    expect(workflow).not.toHaveProperty("outputs");
    expect(workflow).not.toHaveProperty("input_edges");
    expect(workflow).not.toHaveProperty("output_edges");
  });

  it("input_node uses correct field schema format", () => {
    const pattern = BUILTIN_PATTERNS[0];
    const workflow = patternToWorkflow(pattern);

    const inputNode = workflow.input_node as {
      id: string;
      type: string;
      params: { fields: Record<string, { type: string }> };
    };

    expect(inputNode.id).toBe("input");
    expect(inputNode.type).toBe("Input");
    expect(inputNode.params.fields.prompt.type).toBe("string");
    // Must NOT use value_type (causes BaseValueSchema fallback)
    expect(inputNode.params.fields.prompt).not.toHaveProperty("value_type");
  });

  it("output_node uses correct field schema format", () => {
    const pattern = BUILTIN_PATTERNS[0];
    const workflow = patternToWorkflow(pattern);

    const outputNode = workflow.output_node as {
      id: string;
      type: string;
      params: { fields: Record<string, { type: string }> };
    };

    expect(outputNode.id).toBe("output");
    expect(outputNode.type).toBe("Output");
    expect(outputNode.params.fields.response.type).toBe("string");
    expect(outputNode.params.fields.response).not.toHaveProperty("value_type");
  });

  it("inner_nodes contains only model and system_prompt params", () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.id === "summarize")!;
    const workflow = patternToWorkflow(pattern);

    const innerNodes = workflow.inner_nodes as Array<{
      id: string;
      type: string;
      params: Record<string, string>;
    }>;

    expect(innerNodes).toHaveLength(1);
    expect(innerNodes[0].id).toBe("llm");
    expect(innerNodes[0].type).toBe("LLM");
    expect(innerNodes[0].params).toHaveProperty("model");
    expect(innerNodes[0].params).toHaveProperty("system_prompt");
    // temperature and max_tokens are NOT valid in v2 LLM node
    expect(innerNodes[0].params).not.toHaveProperty("temperature");
    expect(innerNodes[0].params).not.toHaveProperty("max_tokens");
  });

  it("edges connect input → llm → output", () => {
    const pattern = BUILTIN_PATTERNS[0];
    const workflow = patternToWorkflow(pattern);

    const edges = workflow.edges as Array<{
      source_id: string;
      source_key: string;
      target_id: string;
      target_key: string;
    }>;

    expect(edges).toHaveLength(2);

    // input → llm
    expect(edges[0]).toEqual({
      source_id: "input",
      source_key: "prompt",
      target_id: "llm",
      target_key: "prompt",
    });

    // llm → output
    expect(edges[1]).toEqual({
      source_id: "llm",
      source_key: "response",
      target_id: "output",
      target_key: "response",
    });
  });

  it("uses model override when provided", () => {
    const pattern = BUILTIN_PATTERNS[0];
    const workflow = patternToWorkflow(pattern, "claude-sonnet-4-6");

    const innerNodes = workflow.inner_nodes as Array<{
      params: { model: string };
    }>;
    expect(innerNodes[0].params.model).toBe("claude-sonnet-4-6");
  });

  it("uses pattern model when no override", () => {
    const customPattern = {
      ...BUILTIN_PATTERNS[0],
      model: "custom-model-v1",
    };
    const workflow = patternToWorkflow(customPattern);

    const innerNodes = workflow.inner_nodes as Array<{
      params: { model: string };
    }>;
    expect(innerNodes[0].params.model).toBe("custom-model-v1");
  });

  it("falls back to config default_model", () => {
    const pattern = { ...BUILTIN_PATTERNS[0] };
    delete (pattern as { model?: string }).model;
    const workflow = patternToWorkflow(pattern);

    const innerNodes = workflow.inner_nodes as Array<{
      params: { model: string };
    }>;
    expect(innerNodes[0].params.model).toBe("gpt-4o-mini");
  });

  it("embeds system prompt from pattern", () => {
    const pattern = BUILTIN_PATTERNS.find((p) => p.id === "summarize")!;
    const workflow = patternToWorkflow(pattern);

    const innerNodes = workflow.inner_nodes as Array<{
      params: { system_prompt: string };
    }>;
    expect(innerNodes[0].params.system_prompt).toBe(pattern.systemPrompt);
    expect(innerNodes[0].params.system_prompt.length).toBeGreaterThan(10);
  });

  it("produces valid JSON for all builtin patterns", () => {
    for (const pattern of BUILTIN_PATTERNS) {
      const workflow = patternToWorkflow(pattern);
      const json = JSON.stringify(workflow);
      const parsed = JSON.parse(json);

      expect(parsed.input_node).toBeDefined();
      expect(parsed.output_node).toBeDefined();
      expect(parsed.inner_nodes).toHaveLength(1);
      expect(parsed.edges).toHaveLength(2);
      expect(parsed.inner_nodes[0].params.system_prompt).toBeTruthy();
    }
  });
});
