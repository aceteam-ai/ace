import { describe, it, expect } from "vitest";
import { BUILTIN_PATTERNS, getPatternById } from "../../src/patterns/index.js";

describe("BUILTIN_PATTERNS", () => {
  it("has 10 built-in patterns", () => {
    expect(BUILTIN_PATTERNS).toHaveLength(10);
  });

  it("has unique IDs", () => {
    const ids = BUILTIN_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has 7 general and 3 government patterns", () => {
    const general = BUILTIN_PATTERNS.filter((p) => p.category === "general");
    const gov = BUILTIN_PATTERNS.filter((p) => p.category === "government");
    expect(general).toHaveLength(7);
    expect(gov).toHaveLength(3);
  });

  it("every pattern has required fields", () => {
    for (const p of BUILTIN_PATTERNS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.category).toBeTruthy();
      expect(p.systemPrompt).toBeTruthy();
      expect(p.systemPrompt.length).toBeGreaterThan(50);
    }
  });

  it("pattern IDs use kebab-case", () => {
    for (const p of BUILTIN_PATTERNS) {
      expect(p.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("getPatternById", () => {
  it("finds existing pattern", () => {
    const pattern = getPatternById("summarize");
    expect(pattern).toBeDefined();
    expect(pattern?.id).toBe("summarize");
    expect(pattern?.category).toBe("general");
  });

  it("finds government pattern", () => {
    const pattern = getPatternById("department-scanner");
    expect(pattern).toBeDefined();
    expect(pattern?.category).toBe("government");
  });

  it("returns undefined for unknown pattern", () => {
    expect(getPatternById("nonexistent")).toBeUndefined();
  });
});
