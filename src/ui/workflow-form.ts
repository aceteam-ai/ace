import { isDeepStrictEqual } from "node:util";
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

function containsOnlyFiniteNumbers(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value !== "object") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const valid = children.every((child) => containsOnlyFiniteNumbers(child, seen));
  seen.delete(value);
  return valid;
}

export function workflowInputFields(fields: Record<string, WorkflowFieldSchema>): WorkflowInputField[] {
  return Object.entries(fields).map(([name, schema]) => ({
    name,
    schema,
    // The pinned engine maps every declared input key. A default can satisfy that
    // mapping; nullable types and schema.required=false do not make a key optional.
    required: !("default" in schema),
  }));
}

export function workflowFieldType(field: WorkflowInputField): string {
  const types = acceptedTypes(field.schema);
  return types.length ? types.join(" | ") : "JSON value";
}

export function parseWorkflowInput(answer: string, field: WorkflowInputField): ParsedWorkflowInput {
  const trimmed = answer.trim();
  const types = acceptedTypes(field.schema);
  let value: unknown;

  if (!trimmed) {
    if ("default" in field.schema) value = structuredClone(field.schema.default);
    else return { include: false, error: `${field.name} is required by the workflow engine.` };
  } else {
    value = answer;
    if (types.length === 1 && types[0] === "string" && trimmed === '""') value = "";
    else if (!(types.length === 1 && types[0] === "string")) {
      try { value = JSON.parse(trimmed); }
      catch {
        if (types.includes("string")) value = answer;
        else return { include: false, error: `${field.name} expects ${workflowFieldType(field)}. Enter valid JSON.` };
      }
    }
  }

  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const compatible = types.length === 0 || types.includes(actual) || (types.includes("integer") && actual === "number" && Number.isInteger(value));
  if (!compatible) return { include: false, error: `${field.name} expects ${workflowFieldType(field)}.` };
  if (!containsOnlyFiniteNumbers(value)) return { include: false, error: `${field.name} must contain only finite numbers.` };
  if (Array.isArray(field.schema.enum) && !field.schema.enum.some((choice) => isDeepStrictEqual(choice, value))) {
    return { include: false, error: `${field.name} must be one of: ${field.schema.enum.map((choice) => JSON.stringify(choice)).join(", ")}.` };
  }
  return { include: true, value };
}
