import type { PlatformTemplate, PlatformTemplateSummary, PlatformRunResult } from "../platform/types.js";
import { validatePlatformTemplateInput } from "../platform/input.js";
import { getWorkflowInputFields } from "../utils/workflow-graph.js";
import { workflowInputFields, type WorkflowInputField } from "./workflow-form.js";
import type { PlatformTemplateService, PlatformTemplateProgress } from "./platform-template-service.js";

export type PlatformExecutionMode = "local" | "remote";
export interface PlatformTemplateReview {
  readonly template: PlatformTemplate;
  readonly mode: PlatformExecutionMode;
  readonly input: Record<string, unknown>;
  readonly text: string;
}
export interface PlatformTemplateState {
  phase: "idle" | "loading" | "catalog" | "opening" | "ready" | "running" | "stopping" | "result";
  templates: readonly PlatformTemplateSummary[];
  template?: PlatformTemplate;
  fields: readonly WorkflowInputField[];
  mode?: PlatformExecutionMode;
  error?: string;
  progress: readonly PlatformTemplateProgress[];
  result?: PlatformRunResult;
  runId?: string;
  jobId?: string;
  stopped?: boolean;
}
interface Operation { kind: "catalog" | "detail" | PlatformExecutionMode; controller: AbortController; work: Promise<void>; cancelled: boolean; dispatched: boolean; settled: boolean }
function freeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value); for (const child of Object.values(value)) freeze(child, seen); Object.freeze(value);
  }
  return value;
}
/** JSON escaping makes otherwise invisible input characters visible without changing the submitted value. */
export function platformReviewJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\p{Cf}\p{Cs}]/gu, (character) =>
    character.split("").map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}
function message(error: unknown): string { return error instanceof Error ? error.message : "The platform operation could not complete."; }

/** Owns one platform operation through cancellation and view navigation. */
export class PlatformTemplateController {
  private state: PlatformTemplateState = { phase: "idle", templates: [], fields: [], progress: [] };
  private readonly listeners = new Set<() => void>();
  private readonly reviews = new WeakMap<PlatformTemplateReview, number>();
  private selectionGeneration = 0;
  private readonly submissions = new WeakMap<PlatformTemplateReview, Promise<void>>();
  private operation?: Operation;
  private disposed = false;
  constructor(private readonly service: PlatformTemplateService) {}
  getSnapshot = (): PlatformTemplateState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PlatformTemplateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot interrupt resource cleanup. */ } }
  }
  private begin(kind: Operation["kind"], action: (operation: Operation) => Promise<void>): Promise<void> {
    if (this.disposed || this.operation) return Promise.resolve();
    const operation: Operation = { kind, controller: new AbortController(), cancelled: false, dispatched: false, settled: false, work: Promise.resolve() };
    this.operation = operation;
    operation.work = Promise.resolve().then(async () => {
      if (operation.controller.signal.aborted) return;
      operation.dispatched = true;
      await action(operation);
    }).catch((error: unknown) => {
      operation.settled = true;
      if (kind === "catalog" || kind === "detail") this.update({ phase: operation.cancelled ? "catalog" : "result", template: undefined, fields: [], error: operation.cancelled ? undefined : message(error) });
      else this.update({ phase: "result", stopped: operation.cancelled,
        runId: error && typeof error === "object" && "runId" in error && typeof error.runId === "string" ? error.runId : this.state.runId,
        jobId: error && typeof error === "object" && "jobId" in error && typeof error.jobId === "string" ? error.jobId : this.state.jobId, error: operation.cancelled
        ? kind === "remote" ? "Stopped waiting. The remote run may continue and consume credits; its outcome is not confirmed." : "Local execution was interrupted."
        : message(error) });
    }).finally(() => {
      operation.settled = true;
      if (this.operation === operation) this.operation = undefined;
      if (this.state.phase === "stopping") this.update({ phase: kind === "catalog" || kind === "detail" ? "catalog" : "result", stopped: true,
        error: !operation.dispatched && (kind === "local" || kind === "remote") ? "Stopped before submission; no execution was started."
          : kind === "remote" ? "Stopped waiting. The remote run may continue and consume credits; its outcome is not confirmed." : undefined });
    });
    return operation.work;
  }
  load = (refresh = false): Promise<void> => {
    if (this.operation || this.disposed || (!refresh && this.state.phase !== "idle")) return Promise.resolve();
    ++this.selectionGeneration;
    const work = this.begin("catalog", async (operation) => {
      const templates = await this.service.list({ signal: operation.controller.signal });
      if (!operation.cancelled) this.update({ phase: "catalog", templates: freeze(structuredClone(templates)), template: undefined, fields: [], error: undefined });
    });
    this.update({ phase: "loading", error: undefined, result: undefined, stopped: false }); return work;
  };
  open = (summary: PlatformTemplateSummary): Promise<void> => {
    if (this.operation || this.disposed || !this.state.templates.some((item) => item.workflowId === summary.workflowId && item.versionNumber === summary.versionNumber)) return Promise.resolve();
    ++this.selectionGeneration;
    const selection = freeze(structuredClone(summary));
    const work = this.begin("detail", async (operation) => {
      const template = await this.service.get(selection, { signal: operation.controller.signal });
      if (operation.cancelled) return;
      if (template.workflowId !== selection.workflowId || template.versionNumber !== selection.versionNumber) throw new Error("The template version changed. Reload the catalog before running it.");
      const fields = workflowInputFields(getWorkflowInputFields(template.graph));
      this.update({ phase: "ready", template: freeze(template), fields: freeze(structuredClone(fields)), error: undefined });
    });
    this.update({ phase: "opening", template: undefined, fields: [], error: undefined, result: undefined, stopped: false }); return work;
  };
  review(mode: PlatformExecutionMode, input: Record<string, unknown>): PlatformTemplateReview {
    if (this.disposed || this.operation || this.state.phase !== "ready" || !this.state.template) throw new Error("Select an accessible template version before reviewing a run.");
    const value = freeze(structuredClone(validatePlatformTemplateInput(this.state.template, input)));
    const text = platformReviewJson({ template: this.state.template.title, workflowId: this.state.template.workflowId,
      version: this.state.template.versionNumber, execution: mode === "remote" ? "Platform run: consumes credits" : "Local runtime: no platform execution credits",
      graph: mode === "remote" ? "The platform executes stored version contents, which may change before execution." : "Uses the fetched local graph snapshot.", input: value });
    if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new Error("The input is too large for the terminal review (1 MiB limit).");
    const review = Object.freeze({ template: this.state.template, mode, input: value, text }); this.reviews.set(review, this.selectionGeneration); return review;
  }
  run = (review: PlatformTemplateReview): Promise<void> => {
    const previous = this.submissions.get(review); if (previous) return previous;
    if (this.disposed || this.operation || this.reviews.get(review) !== this.selectionGeneration || this.state.phase !== "ready" || this.state.template !== review.template) return Promise.resolve();
    const work = this.begin(review.mode, async (operation) => {
      const onProgress = (progress: PlatformTemplateProgress) => {
        if (this.operation !== operation || operation.cancelled) return;
        this.update({ progress: [...this.state.progress.slice(-5), { ...progress }], runId: progress.runId ?? this.state.runId, jobId: progress.jobId ?? this.state.jobId });
      };
      const options = { signal: operation.controller.signal, onProgress };
      const result = await (review.mode === "remote"
        ? this.service.runRemote(review.template, review.input, options)
        : this.service.runLocal(review.template, review.input, options));
      operation.settled = true;
      this.update({ phase: "result", result, stopped: false, error: undefined });
    });
    this.submissions.set(review, work); // Reserve before publishing running state to potentially reentrant views.
    this.update({ phase: "running", mode: review.mode, progress: [], runId: undefined, jobId: undefined, result: undefined, stopped: false, error: undefined }); return work;
  };
  backToCatalog = (): void => {
    if (this.operation || this.disposed) return;
    ++this.selectionGeneration;
    this.update({ phase: "catalog", template: undefined, fields: [], mode: undefined, result: undefined, error: undefined, stopped: false, progress: [], runId: undefined, jobId: undefined });
  };
  stop = (): Promise<void> => {
    const operation = this.operation; if (!operation) return Promise.resolve();
    if (operation.settled) return operation.work;
    if (!operation.cancelled) {
      operation.cancelled = true; operation.controller.abort();
      this.update({ phase: "stopping", error: operation.kind === "remote" ? operation.dispatched ? "Stopping observation; the platform run may continue." : "Stopping before submission…" : "Stopping…" });
    }
    return operation.work;
  };
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }
}
