import { describe, it, expect } from "vitest";
import { TEMPLATES, getTemplateById } from "../../src/templates/index.js";

/**
 * Integration tests verifying that all bundled templates conform to the
 * workflow-engine v2 schema expected by aceteam-nodes >= 0.4.5.
 *
 * Key v2 requirements:
 * - input_node / output_node / inner_nodes / edges (not nodes/inputs/outputs)
 * - Field schemas use {"type": "string"} not {"value_type": "string"}
 * - LLM node params: only "model" and "system_prompt" (no temperature/max_tokens)
 */
describe("v2 template schema compliance", () => {
  it("all templates use v2 top-level structure", () => {
    for (const template of TEMPLATES) {
      const wf = template.workflow;
      expect(wf, `${template.id}: missing input_node`).toHaveProperty("input_node");
      expect(wf, `${template.id}: missing output_node`).toHaveProperty("output_node");
      expect(wf, `${template.id}: missing inner_nodes`).toHaveProperty("inner_nodes");
      expect(wf, `${template.id}: missing edges`).toHaveProperty("edges");

      // Must NOT have v1 fields
      expect(wf, `${template.id}: has v1 'nodes'`).not.toHaveProperty("nodes");
      expect(wf, `${template.id}: has v1 'inputs'`).not.toHaveProperty("inputs");
      expect(wf, `${template.id}: has v1 'outputs'`).not.toHaveProperty("outputs");
      expect(wf, `${template.id}: has v1 'input_edges'`).not.toHaveProperty("input_edges");
      expect(wf, `${template.id}: has v1 'output_edges'`).not.toHaveProperty("output_edges");
    }
  });

  it("input_node field schemas use 'type' not 'value_type'", () => {
    for (const template of TEMPLATES) {
      const inputNode = template.workflow.input_node as {
        params: { fields: Record<string, Record<string, unknown>> };
      };

      for (const [fieldName, schema] of Object.entries(inputNode.params.fields)) {
        expect(schema, `${template.id}.input_node.${fieldName}: must use 'type'`).toHaveProperty("type");
        expect(schema, `${template.id}.input_node.${fieldName}: must not use 'value_type'`).not.toHaveProperty("value_type");
      }
    }
  });

  it("output_node field schemas use 'type' not 'value_type'", () => {
    for (const template of TEMPLATES) {
      const outputNode = template.workflow.output_node as {
        params: { fields: Record<string, Record<string, unknown>> };
      };

      for (const [fieldName, schema] of Object.entries(outputNode.params.fields)) {
        expect(schema, `${template.id}.output_node.${fieldName}: must use 'type'`).toHaveProperty("type");
        expect(schema, `${template.id}.output_node.${fieldName}: must not use 'value_type'`).not.toHaveProperty("value_type");
      }
    }
  });

  it("LLM nodes only have model and system_prompt params", () => {
    const allowedLLMParams = new Set(["model", "system_prompt"]);

    for (const template of TEMPLATES) {
      const innerNodes = template.workflow.inner_nodes as Array<{
        id: string;
        type: string;
        params: Record<string, unknown>;
      }>;

      for (const node of innerNodes) {
        if (node.type === "LLM") {
          for (const key of Object.keys(node.params)) {
            expect(
              allowedLLMParams.has(key),
              `${template.id}.${node.id}: LLM param '${key}' is not allowed in v2 schema`
            ).toBe(true);
          }
        }
      }
    }
  });

  it("all inner_nodes have id and type", () => {
    for (const template of TEMPLATES) {
      const innerNodes = template.workflow.inner_nodes as Array<{
        id: string;
        type: string;
      }>;

      for (const node of innerNodes) {
        expect(node.id, `${template.id}: node missing id`).toBeTruthy();
        expect(node.type, `${template.id}: node missing type`).toBeTruthy();
      }
    }
  });

  it("edges reference valid node IDs", () => {
    for (const template of TEMPLATES) {
      const inputNode = template.workflow.input_node as { id: string };
      const outputNode = template.workflow.output_node as { id: string };
      const innerNodes = template.workflow.inner_nodes as Array<{ id: string }>;
      const edges = template.workflow.edges as Array<{
        source_id: string;
        target_id: string;
      }>;

      const validIds = new Set([
        inputNode.id,
        outputNode.id,
        ...innerNodes.map((n) => n.id),
      ]);

      for (const edge of edges) {
        expect(
          validIds.has(edge.source_id),
          `${template.id}: edge source_id '${edge.source_id}' not a valid node`
        ).toBe(true);
        expect(
          validIds.has(edge.target_id),
          `${template.id}: edge target_id '${edge.target_id}' not a valid node`
        ).toBe(true);
      }
    }
  });

  it("every inner_node is connected by at least one edge", () => {
    for (const template of TEMPLATES) {
      const innerNodes = template.workflow.inner_nodes as Array<{ id: string }>;
      const edges = template.workflow.edges as Array<{
        source_id: string;
        target_id: string;
      }>;

      const connectedIds = new Set([
        ...edges.map((e) => e.source_id),
        ...edges.map((e) => e.target_id),
      ]);

      for (const node of innerNodes) {
        expect(
          connectedIds.has(node.id),
          `${template.id}: node '${node.id}' is disconnected`
        ).toBe(true);
      }
    }
  });

  it("template inputs are extracted correctly from input_node fields", () => {
    for (const template of TEMPLATES) {
      const inputNode = template.workflow.input_node as {
        params: { fields: Record<string, unknown> };
      };
      const expectedInputs = Object.keys(inputNode.params.fields);

      expect(template.inputs).toEqual(expectedInputs);
    }
  });

  it("hello-llm template has single LLM node", () => {
    const t = getTemplateById("hello-llm")!;
    const nodes = t.workflow.inner_nodes as Array<{ type: string }>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].type).toBe("LLM");
    expect(t.inputs).toEqual(["prompt"]);
  });

  it("llm-chain template has two LLM nodes in sequence", () => {
    const t = getTemplateById("llm-chain")!;
    const nodes = t.workflow.inner_nodes as Array<{ id: string; type: string }>;
    expect(nodes).toHaveLength(2);
    expect(nodes[0].type).toBe("LLM");
    expect(nodes[1].type).toBe("LLM");

    // Edges should chain: input → draft → refine → output
    const edges = t.workflow.edges as Array<{
      source_id: string;
      target_id: string;
    }>;
    const draftToRefine = edges.find(
      (e) => e.source_id === "draft" && e.target_id === "refine"
    );
    expect(draftToRefine).toBeDefined();
  });

  it("api-to-llm template has APICall and LLM nodes", () => {
    const t = getTemplateById("api-to-llm")!;
    const nodes = t.workflow.inner_nodes as Array<{ type: string }>;
    const types = nodes.map((n) => n.type);
    expect(types).toContain("APICall");
    expect(types).toContain("LLM");
    expect(t.inputs).toEqual(["url"]);
  });

  it("text-transform template accepts text and instructions", () => {
    const t = getTemplateById("text-transform")!;
    expect(t.inputs).toContain("text");
    expect(t.inputs).toContain("instructions");
  });
});
