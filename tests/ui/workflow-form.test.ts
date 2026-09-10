import { describe, expect, it } from "vitest";
import { parseWorkflowInput, workflowInputFields } from "../../src/ui/workflow-form.js";

describe("schema-aware workflow form", () => {
  it("preserves typed JSON values", () => {
    const [count, enabled, settings, tags] = workflowInputFields({
      count: { type: "integer" }, enabled: { type: "boolean" },
      settings: { type: "object" }, tags: { type: "array" },
    });
    expect(parseWorkflowInput("42", count)).toEqual({ include: true, value: 42 });
    expect(parseWorkflowInput("false", enabled)).toEqual({ include: true, value: false });
    expect(parseWorkflowInput('{"nested":true}', settings)).toEqual({ include: true, value: { nested: true } });
    expect(parseWorkflowInput('["a",2]', tags)).toEqual({ include: true, value: ["a", 2] });
  });

  it("uses valid structured defaults and treats every other mapped key as required", () => {
    const [withDefault, declaredOptional] = workflowInputFields({
      settings: { type: "object", default: { retries: 2 } },
      note: { type: "string", required: false },
    });
    const parsed = parseWorkflowInput("", withDefault);
    expect(parsed).toEqual({ include: true, value: { retries: 2 } });
    expect(parsed.value).not.toBe(withDefault.schema.default);
    expect(declaredOptional.required).toBe(true);
    expect(parseWorkflowInput("", declaredOptional).error).toContain("required by the workflow engine");
  });

  it("keeps required and type errors recoverable", () => {
    const [count] = workflowInputFields({ count: { type: "integer" } });
    expect(parseWorkflowInput("", count).error).toContain("required by the workflow engine");
    expect(parseWorkflowInput("1.5", count).error).toContain("expects integer");
    expect(parseWorkflowInput("not-json", count).error).toContain("valid JSON");
  });

  it("honors nullable unions without treating nullability as omission", () => {
    const [choice] = workflowInputFields({ choice: { type: ["string", "null"], enum: ["a", null] } });
    expect(choice.required).toBe(true);
    expect(parseWorkflowInput("", choice).error).toContain("required by the workflow engine");
    expect(parseWorkflowInput("a", choice)).toEqual({ include: true, value: "a" });
    expect(parseWorkflowInput("null", choice)).toEqual({ include: true, value: null });
    expect(parseWorkflowInput('"b"', choice).error).toContain("one of");
  });

  it("accepts an explicit JSON empty string for a required string enum", () => {
    const [empty] = workflowInputFields({ empty: { type: "string", enum: [""] } });
    expect(parseWorkflowInput("", empty).error).toContain("required by the workflow engine");
    expect(parseWorkflowInput('""', empty)).toEqual({ include: true, value: "" });
  });

  it("rejects non-finite numbers before JSON serialization", () => {
    const [number, withBadDefault, nested] = workflowInputFields({
      number: { type: "number" },
      withBadDefault: { type: "number", default: Number.POSITIVE_INFINITY },
      nested: { type: "object" },
    });
    expect(parseWorkflowInput("1e400", number).error).toContain("finite");
    expect(parseWorkflowInput("", withBadDefault).error).toContain("finite");
    expect(parseWorkflowInput('{"values":[1,1e400]}', nested).error).toContain("finite");
  });

  it("compares structured enum values by JSON structure", () => {
    const [settings, tags] = workflowInputFields({
      settings: { type: "object", enum: [{ mode: "safe", retries: 2 }] },
      tags: { type: "array", enum: [["one", 2]] },
    });
    expect(parseWorkflowInput('{"mode":"safe","retries":2}', settings))
      .toEqual({ include: true, value: { mode: "safe", retries: 2 } });
    expect(parseWorkflowInput('["one",2]', tags))
      .toEqual({ include: true, value: ["one", 2] });
    expect(parseWorkflowInput('{"mode":"other"}', settings).error).toContain("one of");
  });
});
