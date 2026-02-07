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
  workflow: Record<string, unknown>;
}

function defineTemplate(
  id: string,
  category: string,
  workflow: Record<string, unknown>
): TemplateMetadata {
  const inputs = (workflow.inputs as Array<{ name: string }>).map(
    (i) => i.name
  );
  return {
    id,
    name: workflow.name as string,
    description: workflow.description as string,
    category,
    inputs,
    workflow,
  };
}

export const TEMPLATES: TemplateMetadata[] = [
  defineTemplate("hello-llm", "basics", helloLlm),
  defineTemplate("text-transform", "basics", textTransform),
  defineTemplate("llm-chain", "chains", llmChain),
  defineTemplate("api-to-llm", "chains", apiToLlm),
];

export function getTemplateById(id: string): TemplateMetadata | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
