import { getWorkflowInputFields, parseWorkflowGraph, type WorkflowGraph } from "../utils/workflow-graph.js";
import helloLlm from "./hello-llm.json" with { type: "json" };
import textTransform from "./text-transform.json" with { type: "json" };
import llmChain from "./llm-chain.json" with { type: "json" };
import apiToLlm from "./api-to-llm.json" with { type: "json" };
import engineAddition from "./workflow-engine-addition.json" with { type: "json" };
import engineAppend from "./workflow-engine-append.json" with { type: "json" };
import engineError from "./workflow-engine-error.json" with { type: "json" };

export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
  inputs: string[];
  workflow: WorkflowGraph;
  source?: "workflow-engine-v2.0.0rc16";
  runtimeWarning?: string;
}

function defineTemplate(
  id: string,
  category: string,
  workflow: Record<string, unknown>,
  runtimeWarning?: string,
  metadata?: { name: string; description: string; source: "workflow-engine-v2.0.0rc16" }
): TemplateMetadata {
  const graph = parseWorkflowGraph(workflow);
  const inputs = Object.keys(getWorkflowInputFields(graph));

  return {
    id,
    name: metadata?.name ?? (workflow.name as string),
    description: metadata?.description ?? (workflow.description as string),
    category,
    inputs,
    workflow: graph,
    ...(metadata ? { source: metadata.source } : {}),
    ...(runtimeWarning ? { runtimeWarning } : {}),
  };
}

export const TEMPLATES: TemplateMetadata[] = [
  defineTemplate("workflow-engine-addition", "workflow-engine", engineAddition, undefined, {
    name: "Addition", description: "Add two constants to an input number.", source: "workflow-engine-v2.0.0rc16",
  }),
  defineTemplate("workflow-engine-append", "workflow-engine", engineAppend, undefined, {
    name: "Append", description: "Append text to a text file.", source: "workflow-engine-v2.0.0rc16",
  }),
  defineTemplate("workflow-engine-error", "workflow-engine", engineError, undefined, {
    name: "Error", description: "Demonstrate a node failure.", source: "workflow-engine-v2.0.0rc16",
  }),
  defineTemplate("hello-llm", "basics", helloLlm),
  defineTemplate("text-transform", "basics", textTransform),
  defineTemplate("llm-chain", "chains", llmChain),
  defineTemplate("api-to-llm", "chains", apiToLlm),
];

export function getTemplateById(id: string): TemplateMetadata | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
