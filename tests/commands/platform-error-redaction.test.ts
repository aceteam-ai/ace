import { describe, expect, it, vi } from "vitest";
import { PlatformClient, PlatformClientError } from "../../src/platform/client.js";
import { formatPlatformError, formatRemotePlatformResult } from "../../src/commands/templates.js";

const KEY = "act_synthetic_redaction_fixture_only";
const WORKFLOW_ID = "11111111-2222-4333-8444-555555555555";
const GRAPH = {
  name: "Synthetic",
  input_node: { id: "input", type: "Input", params: { fields: {} } },
  inner_nodes: [],
  output_node: { id: "output", type: "Output", params: { fields: {} } },
  edges: [],
};
const TERMINAL = {
  runId: "run-known", workflowVersionId: "version-3", output: {},
  error: { workflow_errors: [], node_errors: {} },
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function sse(...events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function authorizedClient(response: Response) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (new URL(String(input)).pathname.includes("/run/")) return response;
    return json({ workflow: { id: WORKFLOW_ID }, version: {
      id: "version-3", workflow_id: WORKFLOW_ID, version_number: 3, graph: GRAPH,
    } });
  });
  const client = new PlatformClient("https://platform.example", KEY, { fetch });
  const template = await client.getTemplate({ workflowId: WORKFLOW_ID, title: "Fixture", versionNumber: 3 });
  return { client, template, fetch };
}

function expectPrivate(text: string) {
  expect(text).not.toContain(KEY);
  expect(text).toContain("[redacted]");
}

describe("platform credential redaction through CLI formatters", () => {
  it("uses a fixed empty-error fallback instead of server status text", async () => {
    const client = new PlatformClient("https://platform.example", KEY, {
      fetch: vi.fn(async () => new Response("", { status: 401, statusText: KEY })),
    });
    const error = await client.listTemplates().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "authentication_failed", status: 401, outcomeUnknown: false });
    expect(formatPlatformError(error)).not.toContain(KEY);
    expect(formatPlatformError(error)).toContain("HTTP status: 401");
    expect(formatPlatformError(error)).toContain("No error details provided");
  });

  it("redacts error-body reader failures before the CLI sees them", async () => {
    const client = new PlatformClient("https://platform.example", KEY, {
      fetch: vi.fn(async () => new Response(new ReadableStream({
        pull(controller) { controller.error(new Error(`body reader ${KEY}`)); },
      }), { status: 401 })),
    });
    const error = await client.listTemplates().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "response_read_failed", status: 401 });
    expectPrivate(formatPlatformError(error));
  });

  it("keeps stream-reader failures unknown and retains observed IDs", async () => {
    let reads = 0;
    const { client, template, fetch } = await authorizedClient(new Response(new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"start","jobId":"job-known","runId":"run-known"}\n\n'));
        else controller.error(new Error(`stream reader ${KEY}`));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const error = await client.runTemplate(template, {}).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "remote_outcome_unknown", outcomeUnknown: true, jobId: "job-known", runId: "run-known" });
    expectPrivate(formatPlatformError(error));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("redacts a failed JSON response reader and preserves uncertain submission", async () => {
    const { client, template, fetch } = await authorizedClient(new Response(new ReadableStream({
      pull(controller) { controller.error(new Error(`JSON reader ${KEY}`)); },
    }), { headers: { "content-type": "application/json" } }));
    const error = await client.runTemplate(template, {}).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "remote_response_unknown", outcomeUnknown: true });
    expectPrivate(formatPlatformError(error));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps observed IDs when stream observation is aborted", async () => {
    const abort = new AbortController();
    const { client, template } = await authorizedClient(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"start","jobId":"job-known","runId":"run-known"}\n\n' +
          'data: {"type":"node_progress","message":"observed"}\n\n',
        ));
        abort.signal.addEventListener("abort", () => controller.error(new Error("Synthetic abort")), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const error = await client.runTemplate(template, {}, {
      signal: abort.signal, onProgress: () => abort.abort(),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "remote_aborted_unknown", outcomeUnknown: true, jobId: "job-known", runId: "run-known" });
  });

  it("redacts observer exceptions and progress before terminal formatting", async () => {
    const { client, template } = await authorizedClient(sse(
      { type: "start", jobId: "job-known", runId: "run-known" },
      { type: "node_progress", message: `progress ${KEY}` },
    ));
    const observer = vi.fn((progress) => {
      expectPrivate(progress.message);
      throw new Error(`observer ${KEY}`);
    });
    const error = await client.runTemplate(template, {}, { onProgress: observer }).catch((error: unknown) => error);
    expect(observer).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: "remote_observation_unknown", outcomeUnknown: true, jobId: "job-known", runId: "run-known" });
    expectPrivate(formatPlatformError(error));
  });

  it.each(["json", "sse"])("redacts nested %s terminal errors in JSON and human output", async (transport) => {
    const terminal = { ...TERMINAL, error: {
      message: `terminal ${KEY}`, workflow_errors: [{ detail: `workflow ${KEY}` }],
      node_errors: { [KEY]: [{ details: { nested: [`node ${KEY}`] } }] },
    } };
    const { client, template } = await authorizedClient(transport === "json" ? json(terminal) : sse({ type: "complete", ...terminal }));
    const result = await client.runTemplate(template, {});
    expect(result).toMatchObject({ status: "failed", runId: "run-known", workflowVersionId: "version-3" });
    expectPrivate(formatRemotePlatformResult(result, true));
    let failure: unknown;
    try { formatRemotePlatformResult(result, false); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "remote_failed", runId: "run-known", outcomeUnknown: false });
    expectPrivate(formatPlatformError(failure));
  });

  it("redacts a sticky SSE error with no complete event", async () => {
    const { client, template } = await authorizedClient(sse(
      { type: "start", jobId: "job-known" },
      { type: "error", runId: "run-known", message: `SSE failure ${KEY}` },
    ));
    const result = await client.runTemplate(template, {});
    expect(result).toMatchObject({ status: "failed", runId: "run-known", jobId: "job-known" });
    expectPrivate(formatRemotePlatformResult(result, true));
  });

  it("redacts before truncating a long terminal message", async () => {
    const { client, template } = await authorizedClient(json({ ...TERMINAL, error: {
      message: `${"x".repeat(500)}${KEY}`, workflow_errors: [], node_errors: {},
    } }));
    const result = await client.runTemplate(template, {});
    expect(result.error?.message).toBe(`${"x".repeat(500)}[redacted]`);
  });

  it("redacts typed observer failures without losing their code or uncertainty", async () => {
    const { client, template } = await authorizedClient(sse({ type: "node_progress", message: "progress" }));
    const error = await client.runTemplate(template, {}, { onProgress: () => {
      throw new PlatformClientError(`typed ${KEY}`, "fixture_unknown", 502, true, "run-known", "job-known");
    } }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "fixture_unknown", status: 502, outcomeUnknown: true, runId: "run-known", jobId: "job-known" });
    expectPrivate(formatPlatformError(error));
  });
});
