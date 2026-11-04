import type { PlatformTemplateSummary, PlatformTemplate, PlatformRunResult } from "../../../src/platform/types.js";
import type { PlatformTemplateService, PlatformTemplateRunOptions } from "../../../src/ui/platform-template-service.js";

export const TEMPLATE_ID = "10000000-0000-4000-8000-000000000001";
export const VERSION_ID = "20000000-0000-4000-8000-000000000001";
export function templateFixture(title = "Synthetic summary"): PlatformTemplate {
  return { workflowId: TEMPLATE_ID, workflowVersionId: VERSION_ID, versionNumber: 3, title, description: "Synthetic accessible template.", category: "General",
    graph: { input_node: { id: "input", type: "Input", params: { fields: {
      prompt: { type: "string", description: "Text to process.", default: "Synthetic default" },
      count: { type: "integer", default: 3 }, options: { type: "object", default: { enabled: true, values: [1, 2] } },
    } } }, inner_nodes: [], output_node: { id: "output", type: "Output", params: { fields: { response: { type: "string" } } } }, edges: [] } };
}
export class SyntheticPlatformTemplates implements PlatformTemplateService {
  template = templateFixture();
  catalog: PlatformTemplateSummary[] = [this.template, { workflowId: "10000000-0000-4000-8000-000000000002", versionNumber: 1,
    title: "Synthetic analysis", description: "Searchable text.", category: "Analysis" }];
  listCalls: Array<{ signal: AbortSignal }> = [];
  getCalls: Array<{ summary: PlatformTemplateSummary; signal: AbortSignal }> = [];
  runCalls: Array<{ mode: "local" | "remote"; template: PlatformTemplate; input: Record<string, unknown>; options: PlatformTemplateRunOptions }> = [];
  getError?: Error;
  execute?: (call: SyntheticPlatformTemplates["runCalls"][number]) => Promise<PlatformRunResult>;
  async list(options: { signal: AbortSignal }) { this.listCalls.push(options); return this.catalog; }
  async get(summary: PlatformTemplateSummary, options: { signal: AbortSignal }) {
    this.getCalls.push({ summary, ...options }); if (this.getError) throw this.getError;
    return this.template;
  }
  private run(mode: "local" | "remote", template: PlatformTemplate, input: Record<string, unknown>, options: PlatformTemplateRunOptions): Promise<PlatformRunResult> {
    const call = { mode, template, input, options }; this.runCalls.push(call);
    options.onProgress({ message: "Synthetic progress", jobId: "synthetic-job" });
    return this.execute ? this.execute(call) : Promise.resolve({ status: "completed", workflowVersionId: template.workflowVersionId,
      output: { response: "# Synthetic result\n\nComplete output." }, ...(mode === "remote" ? { runId: "synthetic-run" } : {}) });
  }
  runLocal(template: PlatformTemplate, input: Record<string, unknown>, options: PlatformTemplateRunOptions) { return this.run("local", template, input, options); }
  runRemote(template: PlatformTemplate, input: Record<string, unknown>, options: PlatformTemplateRunOptions) { return this.run("remote", template, input, options); }
}
