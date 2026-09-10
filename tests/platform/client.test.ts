import { describe, expect, it, vi } from "vitest";
import { PlatformClient, PlatformClientError } from "../../src/platform/client.js";
import { getPlatformTemplateById } from "../../src/platform/service.js";

const UUID = "11111111-2222-4333-8444-555555555555";
const GRAPH = {
  name: "Synthetic",
  input_node: { id: "input", type: "Input", params: { fields: { prompt: { type: "string" } } } },
  inner_nodes: [{ id: "output_text", type: "Text", params: { text: "ok" } }],
  output_node: { id: "output", type: "Output", params: { fields: { response: { type: "string" } } } },
  edges: [{ source_id: "output_text", source_key: "text", target_id: "output", target_key: "response" }],
};

function catalog(version = 3) {
  return { templates: [{ workflow_id: UUID, title: "Synthetic", description: "Fixture", template_category: "general", version_number: version }] };
}

function detail(version = 3, graph: unknown = GRAPH) {
  return { workflow: { id: UUID }, version: { id: `version-${version}`, workflow_id: UUID, version_number: version, graph } };
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function stream(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function authorizedClient(runResponse: Response | (() => Response)) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/workflow-templates") return json(catalog());
    if (url.pathname === `/api/workflow-engine/${UUID}`) return json(detail());
    return typeof runResponse === "function" ? runResponse() : runResponse;
  });
  const client = new PlatformClient("https://platform.example", "synthetic-key", { fetch });
  const template = await getPlatformTemplateById(client, UUID);
  return { client, template, fetch, calls };
}

describe("PlatformClient catalog authorization", () => {
  it("uses bearer auth, an optional category, and the exact selected version", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      return requests.length === 1 ? json(catalog()) : json(detail());
    });
    const client = new PlatformClient("https://platform.example/", "synthetic-key", { fetch });
    const summaries = await client.listTemplates({ category: "general & safe" });
    const template = await client.getTemplate(summaries[0]);

    expect(requests[0].url.pathname).toBe("/api/workflow-templates");
    expect(requests[0].url.searchParams.get("category")).toBe("general & safe");
    expect(new Headers(requests[0].init?.headers).get("authorization")).toBe("Bearer synthetic-key");
    expect(requests[0].init?.redirect).toBe("manual");
    expect(requests[1].url.pathname).toBe(`/api/workflow-engine/${UUID}`);
    expect(requests[1].url.search).toBe("?version=3");
    expect(template.workflowVersionId).toBe("version-3");
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.graph.input_node.params.fields)).toBe(true);
  });

  it.each([
    [{ workflow: { id: UUID }, version: null }, "unavailable"],
    [detail(4), "does not match"],
    [{ workflow: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, version: detail().version }, "does not match"],
  ])("rejects a missing or stale selected version", async (payload, message) => {
    const client = new PlatformClient("https://platform.example", "key", { fetch: vi.fn(async () => json(payload)) });
    await expect(client.getTemplate(Object.freeze({ workflowId: UUID, title: "Synthetic", versionNumber: 3 }))).rejects.toThrow(message);
  });

  it("never submits when a listed graph is inaccessible", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/workflow-templates") return json(catalog());
      return json({ detail: "denied" }, 403);
    });
    const client = new PlatformClient("https://platform.example", "key", { fetch });
    await expect(getPlatformTemplateById(client, UUID)).rejects.toMatchObject({ code: "authorization_failed", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([input]) => !new URL(String(input)).pathname.includes("/run/"))).toBe(true);
  });

  it("refuses redirects without following them", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 307, headers: { location: "https://other.example" } }));
    const client = new PlatformClient("https://platform.example", "key", { fetch });
    await expect(client.listTemplates()).rejects.toMatchObject({ code: "redirect_refused" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds catalog and error bodies and redacts the credential", async () => {
    const tooLarge = new PlatformClient("https://platform.example", "secret-value", {
      fetch: vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1))),
    });
    await expect(tooLarge.listTemplates()).rejects.toMatchObject({ code: "response_too_large" });

    const echoed = new PlatformClient("https://platform.example", "secret-value", {
      fetch: vi.fn(async () => new Response("denied secret-value\u001b[31m", { status: 401 })),
    });
    const error = await echoed.listTemplates().catch((value: unknown) => value as Error);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("secret-value");
    expect(error.message).not.toContain("\u001b");
  });
});

describe("PlatformClient remote execution", () => {
  it("posts the raw typed input to the pinned version and correlates JSON results", async () => {
    const { client, template, calls } = await authorizedClient(json({
      runId: "run-1", output: { answer: 3 }, error: { workflow_errors: [], node_errors: {} }, workflowVersionId: "version-3", lowCredits: false,
    }));
    const result = await client.runTemplate(template, { prompt: "typed text" });
    const request = calls[2];
    expect(request.url.pathname).toBe(`/api/workflow-engine/run/${UUID}/3`);
    expect(request.init?.method).toBe("POST");
    expect(request.init?.body).toBe(JSON.stringify({ prompt: "typed text" }));
    expect(result).toMatchObject({ status: "completed", runId: "run-1", workflowVersionId: "version-3", output: { answer: 3 } });
  });

  it("requires the exact template object authorized by the same client", async () => {
    const { client, template, fetch } = await authorizedClient(json({}));
    await expect(client.runTemplate(structuredClone(template), {})).rejects.toMatchObject({ code: "unauthorized_template_object" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never treats a mismatched result version as success", async () => {
    const { client, template } = await authorizedClient(json({ output: {}, error: {}, workflowVersionId: "version-other" }));
    await expect(client.runTemplate(template, { prompt: "hello" })).rejects.toMatchObject({ code: "workflow_version_mismatch", outcomeUnknown: true });
  });

  it("parses split UTF-8, comments, mixed line endings, progress, and a multiline complete event", async () => {
    const encoder = new TextEncoder();
    const body = ': comment\r\ndata: {"type":"start","jobId":"job-1"}\r\n\r\ndata: {"type":"node_progress","message":"café","currentNode":1,"totalNodes":2}\n\ndata: {"type":"complete",\r\ndata: "runId":"run-1","workflowVersionId":"version-3","output":{"answer":"done"},"error":{"workflow_errors":[],"node_errors":{}}}\r\n\r\n';
    const bytes = encoder.encode(body);
    const accent = body.indexOf("é");
    const split = encoder.encode(body.slice(0, accent)).byteLength + 1;
    const { client, template } = await authorizedClient(stream([bytes.slice(0, split), bytes.slice(split, split + 3), bytes.slice(split + 3)]));
    const progress = vi.fn();
    const result = await client.runTemplate(template, { prompt: "hello" }, { onProgress: progress });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ type: "node_progress", message: "café", currentNode: 1, totalNodes: 2 }));
    expect(result).toMatchObject({ status: "completed", jobId: "job-1", runId: "run-1", output: { answer: "done" } });
  });

  it.each(["error", "cancelled"] as const)("keeps %s sticky when followed by complete", async (terminalType) => {
    const payload = [
      `data: ${JSON.stringify({ type: "start", jobId: "job-sticky" })}\n\n`,
      `data: ${JSON.stringify({ type: terminalType, runId: "run-sticky", message: "stopped" })}\n\n`,
      `data: ${JSON.stringify({ type: "complete", runId: "run-sticky", workflowVersionId: "version-3", output: { misleading: "success" }, error: { workflow_errors: [], node_errors: {} } })}\n\n`,
    ].join("");
    const { client, template } = await authorizedClient(stream([new TextEncoder().encode(payload)]));
    const result = await client.runTemplate(template, { prompt: "hello" });
    expect(result.status).toBe(terminalType === "error" ? "failed" : "cancelled");
    expect(result).toMatchObject({ jobId: "job-sticky", runId: "run-sticky", workflowVersionId: "version-3" });
  });

  it("reports premature EOF as unknown with available IDs", async () => {
    const payload = `data: ${JSON.stringify({ type: "start", jobId: "job-known", runId: "run-known" })}\n\n`;
    const { client, template } = await authorizedClient(stream([new TextEncoder().encode(payload)]));
    await expect(client.runTemplate(template, { prompt: "hello" })).rejects.toMatchObject({
      code: "remote_outcome_unknown", outcomeUnknown: true, jobId: "job-known", runId: "run-known",
    });
  });

  it("does not retry an uncertain POST transport failure", async () => {
    const { client, template, fetch } = await authorizedClient(() => { throw new Error("socket lost"); });
    await expect(client.runTemplate(template, { prompt: "hello" })).rejects.toMatchObject({ code: "remote_transport_unknown", outcomeUnknown: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("requires a complete JSON terminal envelope and honors node-only redacted failures", async () => {
    const incomplete = await authorizedClient(json({ workflowVersionId: "version-3" }));
    await expect(incomplete.client.runTemplate(incomplete.template, { prompt: "hello" })).rejects.toMatchObject({
      code: "invalid_terminal_result", outcomeUnknown: true,
    });

    const failed = await authorizedClient(json({
      runId: "run-node-error",
      workflowVersionId: "version-3",
      output: {},
      error: { workflow_errors: [], node_errors: { llm: [null] } },
    }));
    await expect(failed.client.runTemplate(failed.template, { prompt: "hello" })).resolves.toMatchObject({
      status: "failed", runId: "run-node-error",
    });
  });

  it("classifies malformed and oversized JSON after POST as unknown without retry", async () => {
    const malformed = await authorizedClient(new Response("{", { headers: { "content-type": "application/json" } }));
    await expect(malformed.client.runTemplate(malformed.template, { prompt: "hello" })).rejects.toMatchObject({
      code: "remote_response_unknown", outcomeUnknown: true,
    });
    expect(malformed.fetch).toHaveBeenCalledTimes(3);

    const oversized = await authorizedClient(new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    await expect(oversized.client.runTemplate(oversized.template, { prompt: "hello" })).rejects.toMatchObject({
      code: "remote_response_unknown", outcomeUnknown: true,
    });
    expect(oversized.fetch).toHaveBeenCalledTimes(3);
  });

  it("treats a server timeout after POST as unknown and does not repeat it", async () => {
    const timedOut = await authorizedClient(new Response("try again".repeat(20_000), { status: 504 }));
    const error = await timedOut.client.runTemplate(timedOut.template, { prompt: "hello" }).catch((value: unknown) => value as PlatformClientError);
    expect(error).toMatchObject({ code: "remote_http_unknown", outcomeUnknown: true, status: 504 });
    expect(error.message).not.toContain("try again");
    expect(timedOut.fetch).toHaveBeenCalledTimes(3);
  });

  it("supports CR-only SSE and bounds each event rather than the whole transport chunk", async () => {
    const progress = `data: ${JSON.stringify({ type: "progress", messagemessage: "ok" })}\r\r`;
    const body = progress.repeat(12_000) + `data: ${JSON.stringify({ type: "complete", runId: "run-cr", workflowVersionId: "version-3", output: {}, error: { workflow_errors: [], node_errors: {} } })}\r\r`;
    const fixture = await authorizedClient(stream([new TextEncoder().encode(body)]));
    await expect(fixture.client.runTemplate(fixture.template, { prompt: "hello" })).resolves.toMatchObject({ status: "completed", runId: "run-cr" });
  });

  it("cancels the owned stream when malformed data ends observation", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: not-json\n\n")); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    const fixture = await authorizedClient(response);
    await expect(fixture.client.runTemplate(fixture.template, { prompt: "hello" })).rejects.toMatchObject({ code: "invalid_stream_event" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed error fields instead of inferring success", async () => {
    const fixture = await authorizedClient(json({
      runId: "run-malformed-error",
      workflowVersionId: "version-3",
      output: {},
      error: { workflow_errors: "failed", node_errors: {} },
    }));
    await expect(fixture.client.runTemplate(fixture.template, { prompt: "hello" })).rejects.toMatchObject({
      code: "invalid_terminal_result", outcomeUnknown: true, runId: "run-malformed-error",
    });
  });

  it("returns a valid completion promptly despite a large trailing coalesced event", async () => {
    const complete = `data: ${JSON.stringify({ type: "complete", runId: "run-first", workflowVersionId: "version-3", output: {}, error: { workflow_errors: [], node_errors: {} } })}\n\n`;
    const trailing = `data: ${"x".repeat(256 * 1024 + 1)}\n\n`;
    const fixture = await authorizedClient(stream([new TextEncoder().encode(complete + trailing)]));
    await expect(fixture.client.runTemplate(fixture.template, { prompt: "hello" })).resolves.toMatchObject({ status: "completed", runId: "run-first" });
  });

  it("dispatches CR-only completion on an open stream and normalizes observer failure", async () => {
    const cancel = vi.fn();
    const complete = `data: ${JSON.stringify({ type: "complete", runId: "run-open", workflowVersionId: "version-3", output: {}, error: { workflow_errors: [], node_errors: {} } })}\r\r`;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(complete)); },
      cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    const first = await authorizedClient(response);
    await expect(first.client.runTemplate(first.template, { prompt: "hello" })).resolves.toMatchObject({ runId: "run-open" });
    expect(cancel).toHaveBeenCalledTimes(1);

    const progress = `data: ${JSON.stringify({ type: "progress", runId: "run-observer" })}\n\n`;
    const second = await authorizedClient(stream([new TextEncoder().encode(progress)]));
    await expect(second.client.runTemplate(second.template, { prompt: "hello" }, {
      onProgress: () => { throw new Error("observer failed"); },
    })).rejects.toMatchObject({ code: "remote_observation_unknown", outcomeUnknown: true, runId: "run-observer" });
  });

  it("rejects an oversized or malformed terminal stream without inferring success", async () => {
    const oversized = `data: ${"x".repeat(256 * 1024 + 1)}\n\n`;
    const first = await authorizedClient(stream([new TextEncoder().encode(oversized)]));
    await expect(first.client.runTemplate(first.template, { prompt: "hello" })).rejects.toMatchObject({ code: "stream_event_too_large", outcomeUnknown: true });

    const second = await authorizedClient(stream([new TextEncoder().encode('data: {"type":"complete"') ]));
    await expect(second.client.runTemplate(second.template, { prompt: "hello" })).rejects.toMatchObject({ code: "incomplete_stream_event", outcomeUnknown: true });
  });
});
