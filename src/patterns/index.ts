import task0 from "./summarize.json" with { type: "json" };
import task1 from "./extract-data.json" with { type: "json" };
import task2 from "./translate.json" with { type: "json" };
import task3 from "./improve-writing.json" with { type: "json" };
import task4 from "./explain.json" with { type: "json" };
import task5 from "./analyze-risk.json" with { type: "json" };
import task6 from "./create-outline.json" with { type: "json" };
import task7 from "./department-scanner.json" with { type: "json" };
import task8 from "./grant-writer.json" with { type: "json" };
import task9 from "./document-summarizer.json" with { type: "json" };
import task10 from "./police-report-writer.json" with { type: "json" };

import { parseWorkflowGraph, type WorkflowGraph } from "../utils/workflow-graph.js";

export interface PatternDef {
  id: string;
  name: string;
  description: string;
  category: string;
  workflow: WorkflowGraph;
  /** Compatibility view derived from the first LLM node, never a second source. */
  readonly systemPrompt: string;
  /** Optional legacy caller override; imported graphs otherwise keep their models. */
  model?: string;
  useDefaultModel?: boolean;
}

export function definePattern(
  id: string,
  category: string,
  value: unknown,
  useDefaultModel = false
): PatternDef {
  const workflow = parseWorkflowGraph(value);
  return {
    id,
    name: workflow.name || id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: workflow.description || `User task: ${id}`,
    category,
    workflow,
    useDefaultModel,
    get systemPrompt() {
      const prompt = workflow.inner_nodes.find((node) => node.type === "LLM")?.params.system_prompt;
      return typeof prompt === "string" ? prompt : "";
    },
  };
}

export const BUILTIN_PATTERNS: PatternDef[] = [
  definePattern("summarize", "general", task0, true),
  definePattern("extract-data", "general", task1, true),
  definePattern("translate", "general", task2, true),
  definePattern("improve-writing", "general", task3, true),
  definePattern("explain", "general", task4, true),
  definePattern("analyze-risk", "general", task5, true),
  definePattern("create-outline", "general", task6, true),
  definePattern("department-scanner", "government", task7, true),
  definePattern("grant-writer", "government", task8, true),
  definePattern("document-summarizer", "government", task9, true),
  definePattern("police-report-writer", "government", task10, true),
];

export function getPatternById(id: string): PatternDef | undefined {
  return BUILTIN_PATTERNS.find((p) => p.id === id);
}
