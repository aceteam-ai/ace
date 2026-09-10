/** The shared wire format; node-specific semantics are validated by Python. */
export interface WorkflowFieldSchema extends Record<string, unknown> {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
}

export interface WorkflowNode extends Record<string, unknown> {
  id: string;
  type: string;
  params: Record<string, unknown>;
}

export interface WorkflowBoundaryNode extends WorkflowNode {
  params: Record<string, unknown> & {
    fields: Record<string, WorkflowFieldSchema>;
  };
}

export interface WorkflowEdge extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  source_key: string | string[];
  target_key: string;
}

export interface WorkflowGraph extends Record<string, unknown> {
  name?: string;
  description?: string;
  input_node: WorkflowBoundaryNode;
  inner_nodes: WorkflowNode[];
  output_node: WorkflowBoundaryNode;
  edges: WorkflowEdge[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid WorkflowGraph: ${path} ${expected}`);
}

function checkNode(value: unknown, path: string): asserts value is WorkflowNode {
  if (!object(value)) invalid(path, "must be an object");
  if (!nonempty(value.id)) invalid(`${path}.id`, "must be a nonempty string");
  if (!nonempty(value.type)) invalid(`${path}.type`, "must be a nonempty string");
  if (!object(value.params)) invalid(`${path}.params`, "must be an object");
}

function checkFields(node: WorkflowNode, path: string): void {
  const fields = node.params.fields;
  if (!object(fields)) invalid(`${path}.params.fields`, "must be an object");
  for (const [name, field] of Object.entries(fields)) {
    if (!nonempty(name) || !object(field)) {
      invalid(`${path}.params.fields.${name}`, "must be a named schema object");
    }
    if ("type" in field && !nonempty(field.type) && !(Array.isArray(field.type) && field.type.length > 0 && field.type.every(nonempty))) {
      invalid(`${path}.params.fields.${name}.type`, "must be a string or array of types");
    }
    // Preserve the engine's schemas, including references and additional metadata.
    for (const key of ["title", "description"]) {
      if (key in field && typeof field[key] !== "string") {
        invalid(`${path}.params.fields.${name}.${key}`, "must be a string");
      }
    }
  }
}

/** Check the graph envelope without replacing the engine's full validation. */
export function parseWorkflowGraph(value: unknown): WorkflowGraph {
  if (!object(value)) invalid("workflow", "must be an object");
  checkNode(value.input_node, "input_node");
  checkNode(value.output_node, "output_node");
  if (value.input_node.type !== "Input") invalid("input_node.type", "must be Input");
  if (value.output_node.type !== "Output") invalid("output_node.type", "must be Output");
  checkFields(value.input_node, "input_node");
  checkFields(value.output_node, "output_node");
  if (!Array.isArray(value.inner_nodes)) invalid("inner_nodes", "must be an array");
  if (!Array.isArray(value.edges)) invalid("edges", "must be an array");
  const ids = new Set([value.input_node.id]);
  for (const [index, node] of value.inner_nodes.entries()) {
    checkNode(node, `inner_nodes[${index}]`);
    if (ids.has(node.id)) invalid(`inner_nodes[${index}].id`, `duplicates ${node.id}`);
    ids.add(node.id);
  }
  if (ids.has(value.output_node.id)) invalid("output_node.id", `duplicates ${value.output_node.id}`);
  ids.add(value.output_node.id);
  for (const [index, edge] of value.edges.entries()) {
    if (!object(edge)) invalid(`edges[${index}]`, "must be an object");
    for (const key of ["source_id", "target_id", "target_key"]) {
      if (!nonempty(edge[key])) invalid(`edges[${index}].${key}`, "must be a nonempty string");
    }
    if (!nonempty(edge.source_key) && !(Array.isArray(edge.source_key) && edge.source_key.length > 0 && edge.source_key.every(nonempty))) {
      invalid(`edges[${index}].source_key`, "must be a nonempty string or path");
    }
    for (const key of ["source_id", "target_id"]) {
      if (!ids.has(edge[key] as string)) invalid(`edges[${index}].${key}`, `references unknown node ${edge[key]}`);
    }
  }
  for (const key of ["name", "description"]) {
    if (key in value && typeof value[key] !== "string") invalid(key, "must be a string");
  }
  return value as WorkflowGraph;
}

/** Input schemas used by both template authoring and the terminal workspace. */
export function getWorkflowInputFields(value: unknown): Record<string, WorkflowFieldSchema> {
  return parseWorkflowGraph(value).input_node.params.fields;
}

/** Preserve JSON parameter types when a template is customized interactively. */
export function parseWorkflowParameter(answer: string, original: unknown): unknown {
  if (!answer.trim()) return original;
  if (typeof original === "string") return answer.trim();
  try {
    const parsed: unknown = JSON.parse(answer);
    const matchesType = original === null
      ? parsed === null
      : Array.isArray(original)
        ? Array.isArray(parsed)
        : parsed !== null && !Array.isArray(parsed) && typeof parsed === typeof original;
    if (!matchesType) throw new Error("type mismatch");
    return parsed;
  } catch {
    throw new Error("Enter valid JSON with the same type as the original parameter.");
  }
}
