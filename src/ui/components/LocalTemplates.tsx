import React from "react";
import { Box, Text } from "ink";
import type { TemplateMetadata } from "../../templates/index.js";
import { getWorkflowInputFields } from "../../utils/workflow-graph.js";
import { sanitizeTerminalText } from "../terminal.js";
import { workflowFieldType, workflowInputFields } from "../workflow-form.js";

export function filterLocalTemplates(templates: TemplateMetadata[], query: string): TemplateMetadata[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return templates;
  return templates.filter((template) => [template.name, template.description, template.category, ...template.inputs]
    .some((value) => value.toLowerCase().includes(normalized)));
}

export function LocalTemplateList({ templates, selected, query }: { templates: TemplateMetadata[]; selected: number; query: string }): React.JSX.Element {
  let previousCategory = "";
  return <Box flexDirection="column">
    <Text bold>Local workflow templates</Text>
    <Text>Filter: <Text color="cyan">{sanitizeTerminalText(query)}▌</Text></Text>
    {templates.length === 0 && <Text color="yellow">No local templates match this filter.</Text>}
    {templates.map((template, index) => {
      const category = template.category !== previousCategory ? template.category : undefined;
      previousCategory = template.category;
      return <Box key={template.id} flexDirection="column">
        {category && <Text bold dimColor>{sanitizeTerminalText(category.toUpperCase())}</Text>}
        <Text color={index === selected ? "cyan" : undefined}>{index === selected ? "❯ " : "  "}{sanitizeTerminalText(template.name)} <Text dimColor>— {sanitizeTerminalText(template.description)}</Text></Text>
      </Box>;
    })}
  </Box>;
}

export function LocalTemplateDetail({ template }: { template: TemplateMetadata }): React.JSX.Element {
  const fields = workflowInputFields(getWorkflowInputFields(template.workflow));
  return <Box flexDirection="column">
    <Text bold>{sanitizeTerminalText(template.name)}</Text>
    <Text>{sanitizeTerminalText(template.description)}</Text>
    <Text dimColor>Category: {sanitizeTerminalText(template.category)} · {template.workflow.inner_nodes.length} node{template.workflow.inner_nodes.length === 1 ? "" : "s"}</Text>
    {template.runtimeWarning && <Box marginTop={1}><Text color="yellow">Warning: {sanitizeTerminalText(template.runtimeWarning)}</Text></Box>}
    <Box marginTop={1} flexDirection="column">
      <Text bold>Input schema</Text>
      {fields.length === 0 && <Text dimColor>No inputs</Text>}
      {fields.map((field) => <Text key={field.name}>• {sanitizeTerminalText(field.schema.title || field.name)} <Text dimColor>({workflowFieldType(field)}{field.required ? ", required" : ""}{"default" in field.schema ? `, default ${JSON.stringify(field.schema.default)}` : ""})</Text>{field.schema.description ? ` — ${sanitizeTerminalText(field.schema.description)}` : ""}</Text>)}
    </Box>
  </Box>;
}
