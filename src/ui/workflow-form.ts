import type { WorkflowFieldSchema } from "../utils/workflow-graph.js";

export interface WorkflowInputField {
  name: string;
  schema: WorkflowFieldSchema;
  required: boolean;
}

export interface ParsedWorkflowInput {
  include: boolean;
  value?: unknown;
  error?: string;
}

function acceptedTypes(schema: WorkflowFieldSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  return schema.type ? [schema.type] : [];
}

export function workflowInputFields(fields: Record<string, WorkflowFieldSchema>): WorkflowInputField[] {
  return Object.entries(fields).map(([name, schema]) => ({
    name,
    schema,
    required: schema.required !== false && !("default" in schema) && !acceptedTypes(schema).includes("null"),
  }));
}

export function workflowFieldType(field: WorkflowInputField): string {
  const types = acceptedTypes(field.schema);
  return types.length ? types.join(" | ") : "JSON value";
}

export function parseWorkflowInput(answer: string, field: WorkflowInputField): ParsedWorkflowInput {
  const trimmed = answer.trim();
  if (!trimmed) {
    if ("default" in field.schema) return { include: true, value: structuredClone(field.schema.default) };
    if (!field.required) return { include: false };
    return { include: false, error: `${field.name} is required.` };
  }

  const types = acceptedTypes(field.schema);
  let value: unknown = answer;
  if (!(types.length === 1 && types[0] === "string")) {
    try { value = JSON.parse(trimmed); }
    catch {
      if (types.includes("string")) value = answer;
      else return { include: false, error: `${field.name} expects ${workflowFieldType(field)}. Enter valid JSON.` };
    }
  }

  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const compatible = types.length === 0 || types.includes(actual) || (types.includes("integer") && actual === "number" && Number.isInteger(value));
  if (!compatible) return { include: false, error: `${field.name} expects ${workflowFieldType(field)}.` };
  if (Array.isArray(field.schema.enum) && !field.schema.enum.some((choice) => Object.is(choice, value))) {
    return { include: false, error: `${field.name} must be one of: ${field.schema.enum.map(String).join(", ")}.` };
  }
  return { include: true, value };
}
