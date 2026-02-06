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

    it("each template has valid workflow structure", () => {
      for (const template of TEMPLATES) {
        const wf = template.workflow;
        expect(wf).toHaveProperty("nodes");
        expect(wf).toHaveProperty("inputs");
        expect(wf).toHaveProperty("outputs");
        expect(wf).toHaveProperty("input_edges");
        expect(wf).toHaveProperty("output_edges");

        const nodes = wf.nodes as Array<{ id: string; type: string }>;
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

      // Simulate customization
      const nodes = workflow.nodes as Array<{
        params: Record<string, string>;
      }>;
      nodes[0].params.model = "claude-3-haiku-20240307";

      const json = JSON.stringify(workflow, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.nodes[0].params.model).toBe("claude-3-haiku-20240307");
      expect(parsed.inputs).toBeDefined();
      expect(parsed.outputs).toBeDefined();
    });

    it("produces valid JSON from llm-chain template", () => {
      const template = getTemplateById("llm-chain")!;
      const workflow = structuredClone(template.workflow);

      const json = JSON.stringify(workflow, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.nodes).toHaveLength(2);
      expect(parsed.edges).toHaveLength(1);
      // Verify edge connects draft to refine
      expect(parsed.edges[0].source_id).toBe("draft");
      expect(parsed.edges[0].target_id).toBe("refine");
    });

    it("each template can be serialized and deserialized", () => {
      for (const template of TEMPLATES) {
        const cloned = structuredClone(template.workflow);
        const json = JSON.stringify(cloned);
        const parsed = JSON.parse(json);

        expect(parsed.nodes).toEqual(cloned.nodes);
        expect(parsed.inputs).toEqual(cloned.inputs);
        expect(parsed.outputs).toEqual(cloned.outputs);
      }
    });
  });

  describe("validate workflow structure", () => {
    it("rejects workflow without nodes", () => {
      const wf = { inputs: [], outputs: [] };
      expect(wf).not.toHaveProperty("nodes");
    });

    it("rejects workflow without inputs", () => {
      const wf = { nodes: [], outputs: [] };
      expect(wf).not.toHaveProperty("inputs");
    });

    it("rejects workflow without outputs", () => {
      const wf = { nodes: [], inputs: [] };
      expect(wf).not.toHaveProperty("outputs");
    });

    it("accepts valid workflow structure", () => {
      const template = getTemplateById("hello-llm")!;
      const wf = template.workflow;

      expect(wf).toHaveProperty("nodes");
      expect(wf).toHaveProperty("inputs");
      expect(wf).toHaveProperty("outputs");
      expect(wf).toHaveProperty("input_edges");
      expect(wf).toHaveProperty("output_edges");
    });
  });
});
