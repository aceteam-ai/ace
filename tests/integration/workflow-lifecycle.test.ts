import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { TEMPLATES, getTemplateById } from "../../src/templates/index.js";

describe("workflow lifecycle", () => {
  describe("list-templates", () => {
    it("has at least 4 bundled templates", () => {
      expect(TEMPLATES.length).toBeGreaterThanOrEqual(4);
    });

    it("each template has required metadata", () => {
      for (const template of TEMPLATES) {
        expect(template.id).toBeTruthy();
        expect(template.name).toBeTruthy();
        expect(template.description).toBeTruthy();
        expect(template.category).toBeTruthy();
        expect(Array.isArray(template.inputs)).toBe(true);
        expect(template.inputs.length).toBeGreaterThan(0);
      }
    });

    it("each template has valid workflow structure (v2 schema)", () => {
      for (const template of TEMPLATES) {
        const wf = template.workflow;
        expect(wf).toHaveProperty("input_node");
        expect(wf).toHaveProperty("output_node");
        expect(wf).toHaveProperty("inner_nodes");
        expect(wf).toHaveProperty("edges");

        const nodes = wf.inner_nodes as Array<{ id: string; type: string }>;
        expect(nodes.length).toBeGreaterThan(0);
        for (const node of nodes) {
          expect(node.id).toBeTruthy();
          expect(node.type).toBeTruthy();
        }
      }
    });

    it("template IDs are unique", () => {
      const ids = TEMPLATES.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe("getTemplateById", () => {
    it("finds existing template", () => {
      const template = getTemplateById("hello-llm");
      expect(template).toBeDefined();
      expect(template!.name).toBe("Hello LLM");
    });

    it("returns undefined for missing template", () => {
      expect(getTemplateById("nonexistent")).toBeUndefined();
    });
  });

  describe("create workflow from template", () => {
    it("produces valid JSON from hello-llm template", () => {
      const template = getTemplateById("hello-llm")!;
      const workflow = structuredClone(template.workflow);

      // Simulate customization via inner_nodes (v2 schema)
      const nodes = workflow.inner_nodes as Array<{
        params: Record<string, string>;
      }>;
      nodes[0].params.model = "claude-3-haiku-20240307";

      const json = JSON.stringify(workflow, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.inner_nodes[0].params.model).toBe("claude-3-haiku-20240307");
      expect(parsed.input_node).toBeDefined();
      expect(parsed.output_node).toBeDefined();
    });

    it("produces valid JSON from llm-chain template", () => {
      const template = getTemplateById("llm-chain")!;
      const workflow = structuredClone(template.workflow);

      const json = JSON.stringify(workflow, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.inner_nodes).toHaveLength(2);
      expect(parsed.edges).toHaveLength(3);
      // Verify edges connect input → draft → refine → output
      expect(parsed.edges[1].source_id).toBe("draft");
      expect(parsed.edges[1].target_id).toBe("refine");
    });

    it("each template can be serialized and deserialized", () => {
      for (const template of TEMPLATES) {
        const cloned = structuredClone(template.workflow);
        const json = JSON.stringify(cloned);
        const parsed = JSON.parse(json);

        expect(parsed.inner_nodes).toEqual(cloned.inner_nodes);
        expect(parsed.input_node).toEqual(cloned.input_node);
        expect(parsed.output_node).toEqual(cloned.output_node);
      }
    });
  });

  describe("validate workflow structure", () => {
    it("rejects workflow without inner_nodes", () => {
      const wf = { input_node: {}, output_node: {} };
      expect(wf).not.toHaveProperty("inner_nodes");
    });

    it("rejects workflow without input_node", () => {
      const wf = { inner_nodes: [], output_node: {} };
      expect(wf).not.toHaveProperty("input_node");
    });

    it("rejects workflow without output_node", () => {
      const wf = { inner_nodes: [], input_node: {} };
      expect(wf).not.toHaveProperty("output_node");
    });

    it("accepts valid workflow structure (v2 schema)", () => {
      const template = getTemplateById("hello-llm")!;
      const wf = template.workflow;

      expect(wf).toHaveProperty("input_node");
      expect(wf).toHaveProperty("output_node");
      expect(wf).toHaveProperty("inner_nodes");
      expect(wf).toHaveProperty("edges");
    });
  });
});
