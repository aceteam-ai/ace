import type { PlatformClient } from "../platform/client.js";
import type { PlatformTemplate, PlatformTemplateSummary, PlatformRunResult } from "../platform/types.js";
import type { runPlatformTemplateLocally } from "../platform/workflow.js";

export interface PlatformTemplateProgress { message: string; runId?: string; jobId?: string }
export interface PlatformTemplateRunOptions { signal: AbortSignal; onProgress: (progress: PlatformTemplateProgress) => void }
/** A lazy boundary: construction does not read credentials, bootstrap Python, or access the network. */
export interface PlatformTemplateService {
  list(options: { signal: AbortSignal }): Promise<PlatformTemplateSummary[]>;
  get(summary: PlatformTemplateSummary, options: { signal: AbortSignal }): Promise<PlatformTemplate>;
  runLocal(template: PlatformTemplate, input: Record<string, unknown>, options: PlatformTemplateRunOptions): Promise<PlatformRunResult>;
  runRemote(template: PlatformTemplate, input: Record<string, unknown>, options: PlatformTemplateRunOptions): Promise<PlatformRunResult>;
}

export function createPlatformTemplateService(options: {
  createClient?: () => Promise<PlatformClient>;
  localRunner?: typeof runPlatformTemplateLocally;
} = {}): PlatformTemplateService {
  let catalogClient: PlatformClient | undefined;
  const owners = new WeakMap<PlatformTemplate, PlatformClient>();
  const owner = (template: PlatformTemplate): PlatformClient => {
    const client = owners.get(template);
    if (!client) throw new Error("Open an accessible platform template before executing it.");
    return client;
  };
  return {
    async list(request) {
      catalogClient = undefined; // A failed connection refresh must not reuse another origin's credentials.
      const client = await (options.createClient ? options.createClient() : import("../platform/client.js").then((module) => module.createPlatformClientFromConfig()));
      request.signal.throwIfAborted();
      const templates = await client.listTemplates(request);
      request.signal.throwIfAborted(); catalogClient = client;
      return templates;
    },
    async get(summary, request) {
      const client = catalogClient;
      if (!client) throw new Error("Reload the platform catalog before opening a template.");
      request.signal.throwIfAborted();
      const template = await client.getTemplate(summary, request);
      request.signal.throwIfAborted(); owners.set(template, client);
      return template;
    },
    async runRemote(template, input, request) {
      const client = owner(template); request.signal.throwIfAborted();
      return client.runTemplate(template, input, { signal: request.signal, onProgress: (event) => request.onProgress({
        message: event.message ?? (event.nodeName ? `${event.type}: ${event.nodeName}` : event.type), runId: event.runId, jobId: event.jobId,
      }) });
    },
    async runLocal(template, input, request) {
      const client = owner(template); request.signal.throwIfAborted();
      const run = options.localRunner ?? (await import("../platform/workflow.js")).runPlatformTemplateLocally;
      request.signal.throwIfAborted();
      const result = await run(client, template, input, {
        signal: request.signal,
        onSetupProgress: (message) => request.onProgress({ message }),
        onProgress: (event) => request.onProgress({ message: event.message ?? (event.nodeName ? `${event.type}: ${event.nodeName}` : event.type) }),
      });
      return { status: result.success ? "completed" : "failed", workflowVersionId: template.workflowVersionId, output: result.output,
        ...(!result.success ? { error: { message: result.error ?? "Local workflow failed.", workflowErrors: [], nodeErrors: {} } } : {}) };
    },
  };
}
