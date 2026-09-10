import { isDeepStrictEqual } from "node:util";
import { getWorkflowInputFields } from "../utils/workflow-graph.js";
import { parseWorkflowInput, workflowInputFields, workflowFieldType, type WorkflowInputField } from "../ui/workflow-form.js";
import type { PlatformTemplate } from "./types.js";

export function platformTemplateInputFields(template: PlatformTemplate): WorkflowInputField[] {
  return workflowInputFields(getWorkflowInputFields(template.graph));
}

function defineInput(result: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
}

function jsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  seen.add(value);
  const valid = Object.getOwnPropertySymbols(value).length === 0 && Object.values(value).every((child) => jsonValue(child, seen));
  seen.delete(value);
  return valid;
}

function actualType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function validateValue(value: unknown, field: WorkflowInputField): void {
  const types = Array.isArray(field.schema.type) ? field.schema.type : field.schema.type ? [field.schema.type] : [];
  const actual = actualType(value);
  const compatible = types.length === 0 || types.includes(actual) || (types.includes("integer") && actual === "number" && Number.isInteger(value));
  if (!compatible) throw new Error(`${field.name} expects ${workflowFieldType(field)}.`);
  if (!jsonValue(value)) throw new Error(`${field.name} must be a finite JSON value.`);
  if (Array.isArray(field.schema.enum) && !field.schema.enum.some((choice) => isDeepStrictEqual(choice, value))) {
    throw new Error(`${field.name} must be one of: ${field.schema.enum.map((choice) => JSON.stringify(choice)).join(", ")}.`);
  }
}

export function validatePlatformTemplateInput(template: PlatformTemplate, input: Record<string, unknown>): Record<string, unknown> {
  const fields = platformTemplateInputFields(template);
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const name of Object.keys(input)) {
    if (!byName.has(name)) throw new Error(`Unknown workflow input: ${name}`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let value: unknown;
    if (Object.hasOwn(input, field.name)) value = input[field.name];
    else if ("default" in field.schema) value = structuredClone(field.schema.default);
    else throw new Error(`${field.name} is required by the workflow engine.`);
    validateValue(value, field);
    defineInput(result, field.name, value);
  }
  return result;
}

export async function collectPlatformTemplateInput(
  template: PlatformTemplate,
  pairs: string[],
  prompt?: (field: WorkflowInputField) => Promise<string>,
): Promise<Record<string, unknown>> {
  const raw = new Map<string, string>();
  for (const pair of pairs) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid input format: ${pair}. Use key=value.`);
    const name = pair.slice(0, separator);
    if (raw.has(name)) throw new Error(`Duplicate workflow input: ${name}`);
    raw.set(name, pair.slice(separator + 1));
  }
  const fields = platformTemplateInputFields(template);
  const names = new Set(fields.map((field) => field.name));
  for (const name of raw.keys()) {
    if (!names.has(name)) throw new Error(`Unknown workflow input: ${name}`);
  }
  const parsedInput: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    let answer = raw.get(field.name);
    if (answer === undefined && !("default" in field.schema) && prompt) answer = await prompt(field);
    const parsed = parseWorkflowInput(answer ?? "", field);
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.include) defineInput(parsedInput, field.name, parsed.value);
  }
  return validatePlatformTemplateInput(template, parsedInput);
}
