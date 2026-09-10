import React from "react";
import { Box, Text } from "ink";
import type { TemplateMetadata } from "../../templates/index.js";
import { getWorkflowInputFields } from "../../utils/workflow-graph.js";
import { sanitizeTerminalText } from "../terminal.js";
import { MarkdownOutput, type MarkdownPhysicalLine } from "./MarkdownOutput.js";
import { workflowFieldType, workflowInputFields } from "../workflow-form.js";

export function filterLocalTemplates(templates: TemplateMetadata[], query: string): TemplateMetadata[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return templates;
  return templates.filter((template) => [template.name, template.description, template.category, ...template.inputs]
    .some((value) => value.toLowerCase().includes(normalized)));
}

type TemplateEntry = { kind: "category"; name: string } | { kind: "template"; template: TemplateMetadata; index: number };

export function LocalTemplateList({ templates, selected, query, width, maxRows }: { templates: TemplateMetadata[]; selected: number; query: string; width: number; maxRows: number }): React.JSX.Element {
  const entries: TemplateEntry[] = [];
  let previousCategory = "";
  templates.forEach((template, index) => {
    if (template.category !== previousCategory) entries.push({ kind: "category", name: template.category });
    entries.push({ kind: "template", template, index });
    previousCategory = template.category;
  });
  const selectedEntry = Math.max(0, entries.findIndex((entry) => entry.kind === "template" && entry.index === selected));
  const entryRows = Math.max(1, maxRows - 2);
  const offset = Math.min(Math.max(0, selectedEntry - Math.floor(entryRows / 2)), Math.max(0, entries.length - entryRows));
  const visible = entries.slice(offset, offset + entryRows);

  return <Box flexDirection="column" width={width}>
    <Text bold wrap="truncate-end">Local workflow templates</Text>
    <Text wrap="truncate-end">Filter: <Text color="cyan">{sanitizeTerminalText(query)}▌</Text></Text>
    {templates.length === 0 && <Text color="yellow" wrap="truncate-end">No local templates match this filter.</Text>}
    {visible.map((entry, index) => entry.kind === "category"
      ? <Text key={String(offset + index) + ":category"} bold dimColor wrap="truncate-end">{sanitizeTerminalText(entry.name.toUpperCase())}</Text>
      : <Text key={entry.template.id} color={entry.index === selected ? "cyan" : undefined} wrap="truncate-end">
          {entry.index === selected ? "❯ " : "  "}{sanitizeTerminalText(entry.template.name)} <Text dimColor>— {sanitizeTerminalText(entry.template.description)}</Text>
        </Text>)}
  </Box>;
}

export function localTemplateDetailText(template: TemplateMetadata): string {
  const fields = workflowInputFields(getWorkflowInputFields(template.workflow));
  const lines = [
    "# " + template.name,
    template.description,
    "Category: " + template.category + " · " + String(template.workflow.inner_nodes.length) + " node" + (template.workflow.inner_nodes.length === 1 ? "" : "s"),
    ...(template.runtimeWarning ? ["⚠ " + template.runtimeWarning] : []),
    "## Input schema",
    ...(fields.length === 0 ? ["No inputs"] : fields.map((field) => {
      const requirement = "default" in field.schema ? "default " + String(JSON.stringify(field.schema.default)) : "required";
      const description = field.schema.description ? " — " + field.schema.description : "";
      return "- " + (field.schema.title || field.name) + " (" + workflowFieldType(field) + " · " + requirement + ")" + description;
    })),
  ];
  return lines.join("\n");
}

export function LocalTemplateDetail({ template, width, maxRows, offset, physical }: { template: TemplateMetadata; width: number; maxRows: number; offset: number; physical?: readonly MarkdownPhysicalLine[] }): React.JSX.Element {
  return <MarkdownOutput physical={physical} value={localTemplateDetailText(template)} width={width} offset={offset} maxLines={maxRows} />;
}
