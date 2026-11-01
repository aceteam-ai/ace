import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { PatternDef } from "../patterns/index.js";
import { DEMOS, type DemoOutput } from "../demos/index.js";
import { TEMPLATES, getTemplateById, type TemplateMetadata } from "../templates/index.js";
import { loadConfig, saveConfig, type AceConfig } from "../utils/config.js";
import { ensurePython } from "../utils/ensure-python.js";
import { validateNodeTypes } from "../utils/node-cache.js";
import { listPatterns, loadPattern, runPattern } from "../utils/patterns.js";
import { detectProvider, type ProviderInfo } from "../utils/provider-detect.js";
import { runWorkflow, type ProgressEvent } from "../utils/python.js";

export interface TaskProgress { message: string; event?: ProgressEvent }
export interface ExecuteOptions { signal: AbortSignal; model?: string; onProgress: (progress: TaskProgress) => void }
export interface WorkspaceTaskService {
  detectProvider(): Promise<ProviderInfo>;
  listPatterns(): PatternDef[];
  listTemplates(): TemplateMetadata[];
  getDemo(patternId: string): DemoOutput | undefined;
  getConfig(): AceConfig;
  executePattern(patternId: string, input: string, options: ExecuteOptions): Promise<string>;
  getWorkflowInputs(filePath: string): string[];
  executeWorkflow(filePath: string, input: Record<string, string>, options: ExecuteOptions): Promise<string>;
  createWorkflow(templateId: string, outputPath: string): string;
  updateDefaultModel(model: string): void;
}

function runtimeProgress(options: ExecuteOptions) {
  return (message: string) => options.onProgress({ message });
}

export const taskService: WorkspaceTaskService = {
  detectProvider,
  listPatterns,
  listTemplates: () => TEMPLATES,
  getDemo: (id) => DEMOS[id],
  getConfig: loadConfig,
  async executePattern(patternId, input, options) {
    const pattern = loadPattern(patternId);
    if (!pattern) throw new Error(`Task not found: ${patternId}`);
    const python = await ensurePython({ signal: options.signal, onProgress: runtimeProgress(options) });
    options.onProgress({ message: `Running ${pattern.name}` });
    return runPattern(python, pattern, input, {
      model: options.model,
      signal: options.signal,
      onProgress: (event) => options.onProgress({ message: progressLabel(event), event }),
    });
  },
  getWorkflowInputs(filePath) {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    let workflow: Record<string, unknown>;
    try { workflow = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>; }
    catch { throw new Error(`Invalid JSON file: ${filePath}`); }
    const fields = (workflow.input_node as { params?: { fields?: Record<string, unknown> } } | undefined)?.params?.fields;
    if (fields) return Object.keys(fields);
    const legacy = workflow.inputs as Array<{ name?: string }> | undefined;
    return legacy?.flatMap((item) => item.name ? [item.name] : []) ?? [];
  },
  async executeWorkflow(filePath, input, options) {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    try { JSON.parse(readFileSync(filePath, "utf-8")); }
    catch { throw new Error(`Invalid JSON file: ${filePath}`); }
    const python = await ensurePython({ signal: options.signal, onProgress: runtimeProgress(options) });
    const { invalid, available } = await validateNodeTypes(python, filePath);
    if (invalid.length) throw new Error(`Unknown node type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}${available.length ? `. Available: ${available.join(", ")}` : ""}`);
    const result = await runWorkflow(python, filePath, input, {
      signal: options.signal,
      onProgress: (event) => options.onProgress({ message: progressLabel(event), event }),
    });
    if (!result.success) throw new Error(result.error ?? "Workflow failed");
    return JSON.stringify(result.output ?? {}, null, 2);
  },
  updateDefaultModel(model) {
    saveConfig({ ...loadConfig(), default_model: model });
  },
  createWorkflow(templateId, outputPath) {
    const template = getTemplateById(templateId);
    if (!template) throw new Error(`Template not found: ${templateId}`);
    if (existsSync(outputPath)) throw new Error(`File already exists: ${outputPath}`);
    writeFileSync(outputPath, `${JSON.stringify(template.workflow, null, 2)}\n`, "utf-8");
    return `Created ${outputPath}`;
  },
};

export function hasLocalProvider(provider?: ProviderInfo): boolean {
  return provider?.provider === "openai" || provider?.provider === "anthropic" || provider?.provider === "ollama";
}

export function progressLabel(event: ProgressEvent): string {
  if (event.type === "started") return `Workflow started${event.totalNodes ? ` (${event.totalNodes} nodes)` : ""}`;
  if (event.type === "node_running") return `Running${event.currentNode && event.totalNodes ? ` ${event.currentNode}/${event.totalNodes}` : ""}: ${event.nodeName ?? "node"}`;
  if (event.type === "node_done") return `Completed: ${event.nodeName ?? "node"}`;
  return `Error in ${event.nodeName ?? "node"}: ${event.message ?? "unknown error"}`;
}
