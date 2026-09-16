import React from "react";
import { Box, Text } from "ink";
import wrapAnsi from "wrap-ansi";
import { sanitizeTerminalText } from "../terminal.js";

export type MarkdownLineKind = "plain" | "heading" | "heading-primary" | "code" | "code-border";

export interface MarkdownPhysicalLine {
  text: string;
  kind: MarkdownLineKind;
}

function normalizeTerminalText(value: string): string {
  return sanitizeTerminalText(value).replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\t/g, "    ");
}

function physicalLines(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return wrapAnsi(value, safeWidth, { hard: true, trim: false }).split("\n");
}

export function formatMarkdownOutput(value: string, width: number): MarkdownPhysicalLine[] {
  const lines: MarkdownPhysicalLine[] = [];
  let inCode = false;

  for (const sourceLine of normalizeTerminalText(value).split("\n")) {
    if (sourceLine.trim().startsWith("```")) {
      inCode = !inCode;
      const marker = inCode ? "┌ code" : "└";
      for (const wrapped of physicalLines(marker, width)) lines.push({ text: wrapped || " ", kind: "code-border" });
      continue;
    }

    let rendered = sourceLine || " ";
    let kind: MarkdownLineKind = "plain";
    if (inCode) {
      rendered = `  ${sourceLine}`;
      kind = "code";
    } else {
      const heading = sourceLine.match(/^(#{1,3})\s+(.+)$/);
      const bullet = sourceLine.match(/^\s*[-*]\s+(.+)$/);
      const numbered = sourceLine.match(/^\s*(\d+\.)\s+(.+)$/);
      if (heading) {
        rendered = heading[2];
        kind = heading[1].length === 1 ? "heading-primary" : "heading";
      } else if (bullet) rendered = `  • ${bullet[1]}`;
      else if (numbered) rendered = `  ${numbered[1]} ${numbered[2]}`;
    }

    for (const wrapped of physicalLines(rendered, width)) lines.push({ text: wrapped || " ", kind });
  }
  return lines;
}

export function boundedTailText(value: string, width: number): string {
  const safe = normalizeTerminalText(value).replace(/\n/g, " ");
  const safeWidth = Math.max(1, width);
  if (physicalLines(safe, safeWidth).length === 1) return safe;
  if (safeWidth === 1) return "…";
  const tail = physicalLines(safe, safeWidth - 1).at(-1) ?? "";
  return "…" + tail;
}

export function boundedTextLines(value: string, width: number, maxLines: number): string[] {
  const all = physicalLines(normalizeTerminalText(value), width).map((line) => line || " ");
  if (all.length <= maxLines) return all;
  const visible = all.slice(0, Math.max(1, maxLines));
  const last = visible.length - 1;
  if (width <= 1) visible[last] = "…";
  else visible[last] = `${physicalLines(visible[last], width - 1)[0] ?? ""}…`;
  return visible;
}

export function MarkdownOutput({ value = "", width = 1, physical, offset = 0, maxLines }: { value?: string; width?: number; physical?: readonly MarkdownPhysicalLine[]; offset?: number; maxLines?: number }): React.JSX.Element {
  const all = physical ?? formatMarkdownOutput(value, width);
  const lines = maxLines === undefined ? all.slice(offset) : all.slice(offset, offset + maxLines);
  return <Box flexDirection="column">
    {lines.map((line, index) => {
      if (line.kind === "code-border") return <Text key={index} dimColor>{line.text}</Text>;
      if (line.kind === "code") return <Text key={index} color="cyan">{line.text}</Text>;
      if (line.kind === "heading-primary") return <Text key={index} bold color="cyan">{line.text}</Text>;
      if (line.kind === "heading") return <Text key={index} bold>{line.text}</Text>;
      return <Text key={index}>{line.text}</Text>;
    })}
  </Box>;
}
