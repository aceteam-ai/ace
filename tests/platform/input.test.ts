import { describe, expect, it } from "vitest";
import { collectPlatformTemplateInput, validatePlatformTemplateInput } from "../../src/platform/input.js";
import type { PlatformTemplate } from "../../src/platform/types.js";

const fields = Object.create(null) as Record<string, unknown>;
Object.assign(fields, {
  text: { type: "string" },
  spaced: { type: "string", default: "  keep whitespace  " },
  quotes: { type: "string", default: '\"\"' },
  count: { type: "integer", default: 3 },
  enabled: { type: "boolean", default: false },
  values: { type: "array", default: ["sample"] },
  choice: { type: "object", enum: [{ nested: [1, 2] }], default: { nested: [1, 2] } },
  constructor: { type: "string", default: "safe" },
});
Object.defineProperty(fields, "__proto__", {
  value: { type: "string", default: "own" },
  enumerable: true,
});

const template = {
  workflowId: "11111111-2222-4333-8444-555555555555",
  workflowVersionId: "version-3",
  versionNumber: 3,
  title: "Typed",
  graph: {
    input_node: { id: "input", type: "Input", params: { fields } },
    inner_nodes: [],
    output_node: { id: "output", type: "Output", params: { fields: {} } },
    edges: [],
  },
} as unknown as PlatformTemplate;

describe("platform template typed inputs", () => {
  it("preserves typed strings exactly and fills structured defaults", () => {
    const result = validatePlatformTemplateInput(template, { text: "  exact  " });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.text).toBe("  exact  ");
    expect(result.spaced).toBe("  keep whitespace  ");
    expect(result.quotes).toBe('\"\"');
    expect(result.count).toBe(3);
    expect(result.enabled).toBe(false);
    expect(result.values).toEqual(["sample"]);
    expect(result.choice).toEqual({ nested: [1, 2] });
    expect(result.constructor).toBe("safe");
    expect(result.__proto__).toBe("own");
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
  });

  it("rejects incompatible, nonfinite, cyclic, unknown, and unequal values", () => {
    expect(() => validatePlatformTemplateInput(template, { text: 3 })).toThrow("text expects string");
    expect(() => validatePlatformTemplateInput(template, { text: "ok", count: Infinity })).toThrow("count expects integer");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validatePlatformTemplateInput(template, { text: "ok", choice: cyclic })).toThrow("finite JSON");
    expect(() => validatePlatformTemplateInput(template, { text: "ok", choice: { nested: [2, 1] } })).toThrow("must be one of");
    expect(() => validatePlatformTemplateInput(template, { text: "ok", extra: true })).toThrow("Unknown workflow input");
  });

  it("parses raw pairs safely, including constructor and __proto__", async () => {
    const result = await collectPlatformTemplateInput(template, [
      "text=hello",
      "count=4",
      "enabled=true",
      'values=["a","b"]',
      'choice={"nested":[1,2]}',
      "constructor=ctor",
      "__proto__=proto",
    ]);
    expect(result).toMatchObject({ text: "hello", count: 4, enabled: true, values: ["a", "b"], constructor: "ctor" });
    expect(result.__proto__).toBe("proto");
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
});
