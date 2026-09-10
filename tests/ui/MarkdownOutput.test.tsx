import React from "react";
import { render, cleanup } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { TEMPLATES } from "../../src/templates/index.js";
import { LocalTemplateDetail, LocalTemplateList, localTemplateDetailText } from "../../src/ui/components/LocalTemplates.js";
import { boundedTailText, boundedTextLines, formatMarkdownOutput, MarkdownOutput } from "../../src/ui/components/MarkdownOutput.js";

afterEach(cleanup);

describe("bounded terminal content", () => {
  it("hard-wraps logical Markdown into physical lines and keeps code context after scrolling", () => {
    const fence = "\x60\x60\x60";
    const value = fence + "ts\nabcdefghijklmnopqrstuvwxyz\n" + fence;
    const lines = formatMarkdownOutput(value, 8);
    expect(lines.every((line) => line.text.length <= 8)).toBe(true);
    expect(lines.filter((line) => line.kind === "code")).toHaveLength(4);
    const tabbed = formatMarkdownOutput("\t12345678", 4);
    expect(tabbed.every((line) => line.text.length <= 4 && !line.text.includes("\t"))).toBe(true);

    const firstCodeLine = lines.findIndex((line) => line.kind === "code");
    const view = render(<MarkdownOutput value={value} width={8} offset={firstCodeLine + 1} maxLines={1} />);
    expect(view.lastFrame()).toContain("ghijklmn");
    expect(view.lastFrame()).not.toContain("┌ code");
  });

  it("bounds long input previews to the requested physical height", () => {
    const tail = boundedTailText("hidden-prefix-" + "x".repeat(160) + "-visible-tail", 41);
    expect(tail).toContain("visible-tail");
    expect(tail.length).toBeLessThanOrEqual(41);
    const lines = boundedTextLines("abcdefghijklmnopqrstuvwxyz", 8, 2);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.length <= 8)).toBe(true);
    expect(lines[1]).toMatch(/…$/);
  });

  it("keeps local template lists compact and makes every detail available by paging", () => {
    const list = render(<LocalTemplateList templates={TEMPLATES} selected={3} query="" width={48} maxRows={5} />);
    expect(list.lastFrame()?.split("\n")).toHaveLength(5);
    expect(list.lastFrame()).toContain("API to LLM");
    list.unmount();

    const template = TEMPLATES[3];
    const detail = localTemplateDetailText(template);
    expect(detail).toContain(template.runtimeWarning);
    expect(detail).toContain("Input schema");
    const physical = formatMarkdownOutput(detail, 48);
    const warningIndex = physical.findIndex((line) => line.text.includes("Authoring example only"));
    expect(warningIndex).toBeGreaterThanOrEqual(0);

    const page = render(<LocalTemplateDetail template={template} width={48} maxRows={3} offset={warningIndex} />);
    expect(page.lastFrame()).toContain("Authoring example only");
    expect(page.lastFrame()?.split("\n").length).toBeLessThanOrEqual(3);
  });
});
