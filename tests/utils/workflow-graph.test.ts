import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../../src/templates/index.js";
import { BUILTIN_PATTERNS } from "../../src/patterns/index.js";
import {
  getWorkflowInputFields,
  parseWorkflowGraph,
  parseWorkflowParameter,
} from "../../src/utils/workflow-graph.js";

const graph = () => structuredClone(BUILTIN_PATTERNS[0].workflow);

describe("WorkflowGraph boundary", () => {
  it("accepts every bundled task and authoring graph unchanged", () => {
    for (const { workflow } of [...BUILTIN_PATTERNS, ...TEMPLATES]) {
      expect(parseWorkflowGraph(workflow)).toBe(workflow);
    }
  });

  it("preserves field defaults, structured schemas, and nested source paths", () => {
    const value = graph();
    value.input_node.params.fields.prompt = {
      type: "string", title: "Source", description: "Synthetic input", default: "sample",
      examples: ["example"],
    };
    value.output_node.params.fields.response = { $ref: "#/$defs/result" };
    value.$defs = { result: { type: "string" } };
    value.edges[0].source_key = ["prompt", "nested"];
    expect(getWorkflowInputFields(value).prompt).toEqual(value.input_node.params.fields.prompt);
    expect(parseWorkflowGraph(value).edges[0].source_key).toEqual(["prompt", "nested"]);
    expect(parseWorkflowGraph(value).$defs).toEqual(value.$defs);
  });

  it.each([
    ["missing edges", (value: ReturnType<typeof graph>) => { delete (value as Record<string, unknown>).edges; }, "edges"],
    ["array parameters", (value: ReturnType<typeof graph>) => { value.inner_nodes[0].params = [] as unknown as Record<string, unknown>; }, "params"],
    ["duplicate boundary ID", (value: ReturnType<typeof graph>) => { value.output_node.id = value.input_node.id; }, "duplicates"],
    ["duplicate inner ID", (value: ReturnType<typeof graph>) => { value.inner_nodes.push(structuredClone(value.inner_nodes[0])); }, "duplicates"],
    ["unknown source", (value: ReturnType<typeof graph>) => { value.edges[0].source_id = "missing"; }, "unknown node"],
    ["empty source path", (value: ReturnType<typeof graph>) => { value.edges[0].source_key = []; }, "source_key"],
    ["invalid boundary role", (value: ReturnType<typeof graph>) => { value.input_node.type = "LLM"; }, "must be Input"],
    ["scalar field schema", (value: ReturnType<typeof graph>) => { value.input_node.params.fields.prompt = "string" as never; }, "schema object"],
  ] as const)("rejects %s before invoking the engine", (_name, change, message) => {
    const value = graph();
    change(value);
    expect(() => parseWorkflowGraph(value)).toThrow(message);
  });

  it("allows an empty passthrough graph", () => {
    const value = graph();
    value.inner_nodes = [];
    value.edges = [{ source_id: "input", source_key: "prompt", target_id: "output", target_key: "response" }];
    expect(parseWorkflowGraph(value)).toEqual(value);
  });
});

describe("template parameter editing", () => {
  it("retains object defaults on Enter and parses JSON edits without stringifying them", () => {
    const fields = { url: { type: "string" } };
    expect(parseWorkflowParameter("", fields)).toBe(fields);
    expect(parseWorkflowParameter('{"url":{"type":"string","default":"sample"}}', fields))
      .toEqual({ url: { type: "string", default: "sample" } });
    expect(parseWorkflowParameter("false", true)).toBe(false);
    expect(parseWorkflowParameter("", false)).toBe(false);
    expect(parseWorkflowParameter("", 7)).toBe(7);
    expect(parseWorkflowParameter("", [1, { nested: true }])).toEqual([1, { nested: true }]);
    expect(parseWorkflowParameter('[2,{"nested":false}]', [1, { nested: true }])).toEqual([2, { nested: false }]);
    expect(parseWorkflowParameter("42", 1)).toBe(42);
    expect(parseWorkflowParameter("42", "model-name")).toBe("42");
  });

  it.each([['"text"', {}], ['[]', {}], ['null', {}], ['{}', []], ['"false"', false], ['{invalid}', {}]])(
    "rejects a parameter edit that corrupts its JSON type",
    (answer, original) => expect(() => parseWorkflowParameter(answer as string, original)).toThrow("same type"),
  );
});
