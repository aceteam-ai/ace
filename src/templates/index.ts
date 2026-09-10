import { getWorkflowInputFields, parseWorkflowGraph, type WorkflowGraph } from "../utils/workflow-graph.js";
import helloLlm from "./hello-llm.json" with { type: "json" };
import textTransform from "./text-transform.json" with { type: "json" };
import llmChain from "./llm-chain.json" with { type: "json" };
import apiToLlm from "./api-to-llm.json" with { type: "json" };

export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
  inputs: string[];
  workflow: WorkflowGraph;
  runtimeWarning?: string;
}

function defineTemplate(
  id: string,
  category: string,
  workflow: Record<string, unknown>,
  runtimeWarning?: string
): TemplateMetadata {
  const graph = parseWorkflowGraph(workflow);
  const inputs = Object.keys(getWorkflowInputFields(graph));

  return {
    id,
    name: workflow.name as string,
    description: workflow.description as string,
    category,
    inputs,
    workflow: graph,
    ...(runtimeWarning ? { runtimeWarning } : {}),
  };
}

export const TEMPLATES: TemplateMetadata[] = [
  defineTemplate("hello-llm", "basics", helloLlm),
  defineTemplate("text-transform", "basics", textTransform),
  defineTemplate("llm-chain", "chains", llmChain),
  defineTemplate("api-to-llm", "chains", apiToLlm,
    "Authoring example only with aceteam-nodes 0.5.1: its APICall node is incompatible with the runner. Use a compatible APICall runtime before executing this workflow."),
];

export function getTemplateById(id: string): TemplateMetadata | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
