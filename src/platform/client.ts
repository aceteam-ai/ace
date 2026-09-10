import { parseWorkflowGraph } from "../utils/workflow-graph.js";
import { validatePlatformTemplateInput } from "./input.js";
import { normalizePlatformOrigin, resolvePlatformCredentials, type PlatformCredentialOptions } from "./config.js";
import type {
  ListPlatformTemplatesOptions,
  PlatformRunErrorDetails,
  PlatformRunProgress,
  PlatformRunResult,
  PlatformTemplate,
  PlatformTemplateSummary,
  RunPlatformTemplateOptions,
} from "./types.js";

const CATALOG_LIMIT = 1024 * 1024;
const DETAIL_LIMIT = 4 * 1024 * 1024;
const ERROR_LIMIT = 16 * 1024;
const SSE_EVENT_LIMIT = 256 * 1024;
const TEXT_FIELD_LIMIT = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetch = typeof fetch;

export class PlatformClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly outcomeUnknown = false,
    public runId?: string,
    public jobId?: string,
  ) {
    super(message);
    this.name = "PlatformClientError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeText(value: string, limit = TEXT_FIELD_LIMIT): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").slice(0, limit);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function unknownOutcome(message: string, code = "remote_outcome_unknown", ids: { runId?: string; jobId?: string; status?: number } = {}): PlatformClientError {
  return new PlatformClientError(`${message} The remote run may continue and consume credits; do not retry automatically.`, code, ids.status, true, ids.runId, ids.jobId);
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new PlatformClientError("Platform response exceeded the allowed size.", "response_too_large", response.status);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decodeJson(bytes: Uint8Array, context: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PlatformClientError(`Platform returned invalid ${context} JSON.`, "invalid_json");
  }
}

function runError(value: unknown): PlatformRunErrorDetails | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const message = safeText(value);
    return message ? { message, workflowErrors: [], nodeErrors: {} } : undefined;
  }
  if (!object(value)) return { message: "Platform reported an invalid execution error.", workflowErrors: [], nodeErrors: {} };
  const workflowErrors = Array.isArray(value.workflow_errors) ? value.workflow_errors : [];
  const nodeErrors = object(value.node_errors) ? value.node_errors : {};
  const hasNodeErrors = Object.values(nodeErrors).some((entry) => Array.isArray(entry) ? entry.length > 0 : true);
  const message = optionalText(value.message);
  if (!message && workflowErrors.length === 0 && !hasNodeErrors) return undefined;
  return { message: message ? safeText(message) : undefined, workflowErrors, nodeErrors };
}

function parseRunResult(value: unknown, template: PlatformTemplate, sticky?: "failed" | "cancelled", jobId?: string): PlatformRunResult {
  if (!object(value)) throw unknownOutcome("Platform returned a malformed terminal result.", "invalid_terminal_result");
  const workflowVersionId = text(value.workflowVersionId);
  const runId = text(value.runId);
  if (!workflowVersionId || workflowVersionId !== template.workflowVersionId) {
    throw unknownOutcome("Platform returned a missing or mismatched workflow version.", "workflow_version_mismatch", { runId, jobId });
  }
  if (!runId || !Object.hasOwn(value, "output") || !object(value.error)) {
    throw unknownOutcome("Platform returned an incomplete terminal result.", "invalid_terminal_result", { runId, jobId });
  }
  if (!Array.isArray(value.error.workflow_errors) || !object(value.error.node_errors)) {
    throw unknownOutcome("Platform returned an invalid execution error container.", "invalid_terminal_result", { runId, jobId });
  }
  const error = runError(value.error);
  const status = sticky ?? (error ? "failed" : "completed");
  return {
    status,
    workflowVersionId,
    runId,
    ...(jobId ? { jobId } : {}),
    output: value.output,
    ...(error ? { error } : {}),
    ...(typeof value.lowCredits === "boolean" ? { lowCredits: value.lowCredits } : {}),
  };
}

export interface PlatformClientOptions {
  fetch?: Fetch;
}

export class PlatformClient {
  readonly origin: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #authorizedTemplates = new WeakSet<object>();

  constructor(origin: string, apiKey: string, options: PlatformClientOptions = {}) {
    this.origin = normalizePlatformOrigin(origin);
    if (!apiKey.trim() || apiKey.length > 8192) throw new Error("Platform API key is invalid.");
    this.#apiKey = apiKey.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) throw new Error("Fetch is unavailable in this Node.js runtime.");
  }

  async #fetchResponse(path: string, init: RequestInit, runSubmission = false): Promise<Response> {
    try {
      const response = await this.#fetch(new URL(path, this.origin), {
        ...init,
        redirect: "manual",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.#apiKey}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
      });
      if (response.status >= 300 && response.status < 400) {
        throw new PlatformClientError("Platform redirects are refused for credentialed requests.", "redirect_refused", response.status, runSubmission);
      }
      return response;
    } catch (error) {
      if (error instanceof PlatformClientError) throw error;
      const raw = error instanceof Error ? error.message : String(error);
      const message = safeText(raw.replaceAll(this.#apiKey, "[redacted]"));
      if (runSubmission) throw unknownOutcome(`Remote submission could not be observed: ${message}`, "remote_transport_unknown");
      throw new PlatformClientError(`Platform request failed: ${message}`, "transport_error");
    }
  }

  async #requireOk(response: Response, runSubmission = false): Promise<void> {
    if (response.ok) return;
    if (runSubmission && (response.status === 408 || response.status >= 500)) {
      try { await readBounded(response, ERROR_LIMIT); } catch { /* outcome remains unknown */ }
      throw unknownOutcome(`Platform returned HTTP ${response.status} after submission.`, "remote_http_unknown", { status: response.status });
    }
    const bytes = await readBounded(response, ERROR_LIMIT);
    const raw = new TextDecoder().decode(bytes);
    const detail = safeText(raw.replaceAll(this.#apiKey, "[redacted]"), ERROR_LIMIT) || response.statusText;
    const code = response.status === 401 ? "authentication_failed"
      : response.status === 403 ? "authorization_failed"
        : response.status === 402 ? "credits_required"
          : response.status === 429 ? "rate_limited" : "http_error";
    throw new PlatformClientError(`Platform request failed (${response.status}): ${detail}`, code, response.status);
  }

  async listTemplates(options: ListPlatformTemplatesOptions = {}): Promise<PlatformTemplateSummary[]> {
    const url = new URL("/api/workflow-templates", this.origin);
    if (options.category) url.searchParams.set("category", options.category);
    const response = await this.#fetchResponse(`${url.pathname}${url.search}`, { method: "GET", signal: options.signal });
    await this.#requireOk(response);
    const value = decodeJson(await readBounded(response, CATALOG_LIMIT), "template catalog");
    if (!object(value) || !Array.isArray(value.templates)) {
      throw new PlatformClientError("Platform returned an invalid template catalog.", "invalid_catalog");
    }
    return value.templates.map((entry, index) => {
      if (!object(entry)) throw new PlatformClientError(`Platform template ${index + 1} is invalid.`, "invalid_catalog");
      const workflowId = text(entry.workflow_id);
      const title = text(entry.title);
      const versionNumber = positiveInteger(entry.version_number);
      if (!workflowId || !UUID.test(workflowId) || !title || !versionNumber) {
        throw new PlatformClientError(`Platform template ${index + 1} has invalid identity metadata.`, "invalid_catalog");
      }
      return deepFreeze({
        workflowId,
        title: safeText(title),
        ...(optionalText(entry.description) ? { description: safeText(entry.description as string, 4096) } : {}),
        ...(optionalText(entry.template_category) ? { category: safeText(entry.template_category as string) } : {}),
        versionNumber,
      });
    });
  }

  async getTemplate(summary: PlatformTemplateSummary, options: { signal?: AbortSignal } = {}): Promise<PlatformTemplate> {
    if (!UUID.test(summary.workflowId) || !positiveInteger(summary.versionNumber)) {
      throw new PlatformClientError("Template selection has invalid identity metadata.", "invalid_template_selection");
    }
    const path = `/api/workflow-engine/${encodeURIComponent(summary.workflowId)}?version=${summary.versionNumber}`;
    const response = await this.#fetchResponse(path, { method: "GET", signal: options.signal });
    await this.#requireOk(response);
    const value = decodeJson(await readBounded(response, DETAIL_LIMIT), "template detail");
    if (!object(value) || !object(value.workflow)) {
      throw new PlatformClientError("Platform returned an invalid template detail.", "invalid_template_detail");
    }
    if (value.version === null) throw new PlatformClientError("The selected template version is unavailable.", "template_version_missing");
    if (!object(value.version)) throw new PlatformClientError("Platform returned an invalid template version.", "invalid_template_detail");
    const workflowId = text(value.workflow.id);
    const versionWorkflowId = text(value.version.workflow_id);
    const versionNumber = positiveInteger(value.version.version_number);
    const workflowVersionId = text(value.version.id);
    if (workflowId !== summary.workflowId || versionWorkflowId !== summary.workflowId || versionNumber !== summary.versionNumber || !workflowVersionId) {
      throw new PlatformClientError("Platform template identity does not match the selected catalog version.", "template_identity_mismatch");
    }
    let graph;
    try {
      graph = structuredClone(parseWorkflowGraph(value.version.graph));
    } catch (error) {
      throw new PlatformClientError(error instanceof Error ? error.message : "Platform template graph is invalid.", "invalid_template_graph");
    }
    const template = deepFreeze({ ...summary, workflowVersionId, graph });
    this.#authorizedTemplates.add(template);
    return template;
  }

  assertAuthorizedTemplate(template: PlatformTemplate): void {
    if (!this.#authorizedTemplates.has(template)) {
      throw new PlatformClientError("Execution requires the exact authorized template returned by getTemplate().", "unauthorized_template_object");
    }
  }

  async runTemplate(template: PlatformTemplate, input: Record<string, unknown>, options: RunPlatformTemplateOptions = {}): Promise<PlatformRunResult> {
    if (!Object.isFrozen(template) || !UUID.test(template.workflowId) || !positiveInteger(template.versionNumber)) {
      throw new PlatformClientError("Remote execution requires an authorized platform template.", "unauthorized_template_object");
    }
    this.assertAuthorizedTemplate(template);
    if (options.signal?.aborted) throw new PlatformClientError("Platform run cancelled before submission.", "request_aborted");
    const validatedInput = validatePlatformTemplateInput(template, input);
    const path = `/api/workflow-engine/run/${encodeURIComponent(template.workflowId)}/${template.versionNumber}`;
    let response: Response;
    try {
      response = await this.#fetchResponse(path, { method: "POST", body: JSON.stringify(validatedInput), signal: options.signal }, true);
      await this.#requireOk(response, true);
    } catch (error) {
      if (options.signal?.aborted && !(error instanceof PlatformClientError && error.outcomeUnknown)) {
        throw unknownOutcome("Remote observation was aborted.", "remote_aborted_unknown");
      }
      throw error;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.#readRunStream(response, template, options);
    }
    try {
      return parseRunResult(decodeJson(await readBounded(response, DETAIL_LIMIT), "run result"), template);
    } catch (error) {
      if (options.signal?.aborted) throw unknownOutcome("Remote observation was aborted.", "remote_aborted_unknown");
      if (error instanceof PlatformClientError && error.outcomeUnknown) throw error;
      const detail = safeText(error instanceof Error ? error.message : String(error));
      throw unknownOutcome(`Platform run response could not be confirmed: ${detail}`, "remote_response_unknown");
    }
  }

  async #readRunStream(response: Response, template: PlatformTemplate, options: RunPlatformTemplateOptions): Promise<PlatformRunResult> {
    if (!response.body) throw unknownOutcome("Platform closed the run stream without terminal evidence.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let skipLeadingLf = false;
    let dataLines: string[] = [];
    let eventBytes = 0;
    let sticky: "failed" | "cancelled" | undefined;
    let stickyError: PlatformRunErrorDetails | undefined;
    let jobId: string | undefined;
    let runId: string | undefined;
    let terminal: PlatformRunResult | undefined;

    const dispatch = () => {
      if (dataLines.length === 0) return;
      const payload = dataLines.join("\n");
      dataLines = [];
      eventBytes = 0;
      let event: unknown;
      try { event = JSON.parse(payload); }
      catch { throw unknownOutcome("Platform returned malformed streaming data.", "invalid_stream_event"); }
      if (!object(event) || typeof event.type !== "string") throw unknownOutcome("Platform returned malformed streaming data.", "invalid_stream_event");
      const type = event.type;
      jobId = text(event.jobId) ?? jobId;
      runId = text(event.runId) ?? runId;
      if (type === "start") {
        jobId = text(event.jobId) ?? jobId;
      } else if (type === "error") {
        sticky = "failed";
        stickyError = runError(event.error ?? event.message) ?? { message: "Platform reported remote execution failure.", workflowErrors: [], nodeErrors: {} };
      } else if (type === "cancelled") {
        sticky = "cancelled";
      } else if (type === "complete") {
        terminal = parseRunResult(event, template, sticky, jobId);
        if (stickyError && !terminal.error) terminal.error = stickyError;
      } else {
        const progress: PlatformRunProgress = {
          type: safeText(type),
          ...(optionalText(event.message) ? { message: safeText(event.message as string) } : {}),
          ...(optionalText(event.nodeName) ? { nodeName: safeText(event.nodeName as string) } : {}),
          ...(positiveInteger(event.currentNode) ? { currentNode: event.currentNode as number } : {}),
          ...(positiveInteger(event.totalNodes) ? { totalNodes: event.totalNodes as number } : {}),
          ...(text(event.runId) ? { runId: text(event.runId) } : {}),
          ...(text(event.jobId) ? { jobId: text(event.jobId) } : {}),
        };
        options.onProgress?.(progress);
      }
    };

    const line = (value: string) => {
      if (value === "") { dispatch(); return; }
      if (value.startsWith(":")) return;
      if (!value.startsWith("data:")) return;
      const data = value.slice(5).replace(/^ /, "");
      eventBytes += Buffer.byteLength(data, "utf8") + 1;
      if (eventBytes > SSE_EVENT_LIMIT) throw unknownOutcome("Platform streaming event exceeded the allowed size.", "stream_event_too_large");
      dataLines.push(data);
    };

    const drainLines = (final = false) => {
      if (skipLeadingLf) {
        if (pending.startsWith("\n")) pending = pending.slice(1);
        skipLeadingLf = false;
      }
      let start = 0;
      let index = 0;
      while (index < pending.length) {
        const character = pending[index];
        if (character !== "\r" && character !== "\n") { index++; continue; }
        line(pending.slice(start, index));
        if (character === "\r" && pending[index + 1] === "\n") index += 2;
        else {
          index += 1;
          if (character === "\r" && index === pending.length && !final) skipLeadingLf = true;
        }
        start = index;
        if (terminal) break;
      }
      pending = pending.slice(start);
      if (final && pending && !terminal) {
        const tail = pending;
        pending = "";
        line(tail);
      }
    };

    try {
      while (!terminal) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (error) {
          if (options.signal?.aborted) throw unknownOutcome("Remote observation was aborted.", "remote_aborted_unknown");
          throw unknownOutcome(`Platform run stream disconnected: ${safeText(error instanceof Error ? error.message : String(error))}`);
        }
        if (chunk.done) break;
        try { pending += decoder.decode(chunk.value, { stream: true }); }
        catch { throw unknownOutcome("Platform returned invalid UTF-8 streaming data.", "invalid_stream_encoding"); }
        drainLines();
        if (terminal) break;
        if (Buffer.byteLength(pending, "utf8") + eventBytes > SSE_EVENT_LIMIT) {
          throw unknownOutcome("Platform streaming event exceeded the allowed size.", "stream_event_too_large");
        }
      }
      if (terminal) return terminal;
      try { pending += decoder.decode(); }
      catch { throw unknownOutcome("Platform returned invalid UTF-8 streaming data.", "invalid_stream_encoding"); }
      drainLines(true);
      if (terminal) return terminal;
      if (dataLines.length > 0) throw unknownOutcome("Platform run stream ended during an event.", "incomplete_stream_event");
      if (sticky) {
        return {
          status: sticky,
          ...(jobId ? { jobId } : {}),
          ...(runId ? { runId } : {}),
          ...(stickyError ? { error: stickyError } : {}),
        };
      }
      throw unknownOutcome("Platform run stream ended without terminal evidence.");
    } catch (error) {
      const failure = error instanceof PlatformClientError
        ? error
        : unknownOutcome(`Platform stream observation failed: ${safeText(error instanceof Error ? error.message : String(error))}`, "remote_observation_unknown");
      if (failure.outcomeUnknown) {
        failure.runId ??= runId;
        failure.jobId ??= jobId;
      }
      throw failure;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export interface CreatePlatformClientOptions extends PlatformCredentialOptions, PlatformClientOptions {}

export async function createPlatformClientFromConfig(options: CreatePlatformClientOptions = {}): Promise<PlatformClient> {
  const credentials = await resolvePlatformCredentials(options);
  return new PlatformClient(credentials.origin, credentials.apiKey, { fetch: options.fetch });
}
