import { describe, it, expect } from "vitest";
import { DEMOS, type DemoOutput } from "../../src/demos/index.js";

describe("canned demos", () => {
  it("has demos for explain and summarize patterns", () => {
    expect(DEMOS).toHaveProperty("explain");
    expect(DEMOS).toHaveProperty("summarize");
  });

  it("each demo has non-empty input and output", () => {
    for (const [id, demo] of Object.entries(DEMOS)) {
      expect(demo.input, `${id} should have input`).toBeTruthy();
      expect(demo.input.length, `${id} input should be non-trivial`).toBeGreaterThan(10);
      expect(demo.output, `${id} should have output`).toBeTruthy();
      expect(demo.output.length, `${id} output should be non-trivial`).toBeGreaterThan(50);
    }
  });

  it("demo output looks like LLM-generated content", () => {
    // Summarize demo should have structure (bullets, headers, etc.)
    const summarize = DEMOS.summarize;
    expect(summarize.output).toMatch(/[#\-*•]/);

    // Explain demo should have structure too
    const explain = DEMOS.explain;
    expect(explain.output).toMatch(/[#\-*•]/);
  });

  it("demos are usable as fallback when no provider is configured", () => {
    // The key contract: DEMOS[patternId] can be looked up by pattern ID
    // and has the DemoOutput shape
    const demo: DemoOutput | undefined = DEMOS["summarize"];
    expect(demo).toBeDefined();
    expect(typeof demo!.input).toBe("string");
    expect(typeof demo!.output).toBe("string");
  });

  it("returns undefined for patterns without demos", () => {
    expect(DEMOS["nonexistent-pattern"]).toBeUndefined();
    // Most patterns don't have canned demos
    expect(DEMOS["analyze-risk"]).toBeUndefined();
  });
});
