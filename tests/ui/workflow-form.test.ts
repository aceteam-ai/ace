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

  it("uses structured defaults and omits blank optional fields", () => {
    const [withDefault, optional] = workflowInputFields({
      settings: { type: "object", default: { retries: 2 } },
      note: { type: "string", required: false },
    });
    const parsed = parseWorkflowInput("", withDefault);
    expect(parsed).toEqual({ include: true, value: { retries: 2 } });
    expect(parsed.value).not.toBe(withDefault.schema.default);
    expect(parseWorkflowInput("", optional)).toEqual({ include: false });
  });

  it("keeps required and type errors recoverable", () => {
    const [count] = workflowInputFields({ count: { type: "integer" } });
    expect(parseWorkflowInput("", count).error).toBe("count is required.");
    expect(parseWorkflowInput("1.5", count).error).toContain("expects integer");
    expect(parseWorkflowInput("not-json", count).error).toContain("valid JSON");
  });

  it("honors nullable unions and enums", () => {
    const [choice] = workflowInputFields({ choice: { type: ["string", "null"], enum: ["a", null] } });
    expect(choice.required).toBe(false);
    expect(parseWorkflowInput("a", choice)).toEqual({ include: true, value: "a" });
    expect(parseWorkflowInput("null", choice)).toEqual({ include: true, value: null });
    expect(parseWorkflowInput('"b"', choice).error).toContain("one of");
  });
});
