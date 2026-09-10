import { describe, expect, it, vi } from "vitest";
import * as clientModule from "../../src/platform/client.js";
import { PlatformClient } from "../../src/platform/client.js";
import { createPlatformTemplateService } from "../../src/ui/platform-template-service.js";
import { templateFixture } from "./fixtures/platform-template-scenario.js";

function connection(origin: string) {
  const template = templateFixture();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "POST") return Response.json({ runId: "synthetic-run", workflowVersionId: template.workflowVersionId,
      output: { response: "Synthetic result" }, error: { workflow_errors: [], node_errors: {} } });
    if (String(_url).includes("workflow-templates")) return Response.json({ templates: [{ workflow_id: template.workflowId,
      title: template.title, template_category: template.category, version_number: template.versionNumber }] });
    return Response.json({ workflow: { id: template.workflowId }, version: { id: template.workflowVersionId, workflow_id: template.workflowId,
      version_number: template.versionNumber, graph: template.graph } });
  });
  return { client: new PlatformClient(origin, "synthetic-test-key", { fetch }), fetch };
}
const options = () => ({ signal: new AbortController().signal, onProgress: vi.fn() });
describe("platform template production service boundary", () => {
  it("constructs without reading credentials and resolves them only on catalog entry", async () => {
    const { client, fetch } = connection("https://platform.example");
    const create = vi.spyOn(clientModule, "createPlatformClientFromConfig").mockResolvedValue(client);
    try {
      const service = createPlatformTemplateService(); expect(create).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      await service.list(options()); expect(create).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { create.mockRestore(); }
  });
  it("retains the authorized graph and its original client across refresh, with remote input unchanged and no local bootstrap", async () => {
    const a = connection("https://first.example"); const b = connection("https://second.example");
    const createClient = vi.fn().mockResolvedValueOnce(a.client).mockResolvedValueOnce(b.client);
    const localRunner = vi.fn(); const service = createPlatformTemplateService({ createClient, localRunner });
    const template = await service.get((await service.list(options()))[0], options());
    const input = { prompt: "Reviewed synthetic input", count: 7, options: { enabled: false, values: [2] } };
    await service.list(options()); const result = await service.runRemote(template, input, options());
    expect(result.status).toBe("completed"); expect(localRunner).not.toHaveBeenCalled();
    expect(a.fetch).toHaveBeenCalledTimes(3); expect(b.fetch).toHaveBeenCalledTimes(1);
    const [url, request] = a.fetch.mock.calls[2]; expect(String(url)).toBe(`https://first.example/api/workflow-engine/run/${template.workflowId}/3`);
    expect(JSON.parse(request!.body as string)).toEqual(input); expect(Object.isFrozen(template.graph)).toBe(true);
    await expect(service.runRemote(structuredClone(template), input, options())).rejects.toThrow("Open an accessible");
    expect(a.fetch).toHaveBeenCalledTimes(3);
  });
  it("does not fall back to a prior connection after a failed refresh", async () => {
    const { client, fetch } = connection("https://platform.example");
    const service = createPlatformTemplateService({ createClient: vi.fn().mockResolvedValueOnce(client).mockRejectedValueOnce(new Error("Connection unavailable")) });
    const summary = (await service.list(options()))[0]; await expect(service.list(options())).rejects.toThrow("unavailable");
    await expect(service.get(summary, options())).rejects.toThrow("Reload"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("passes the exact authorized snapshot to the local runner and preserves its failure details", async () => {
    const { client, fetch } = connection("https://platform.example");
    const localRunner = vi.fn().mockResolvedValue({ success: false, error: "Synthetic local node is unavailable" });
    const service = createPlatformTemplateService({ createClient: async () => client, localRunner });
    const template = await service.get((await service.list(options()))[0], options()); const input = { prompt: "local" }; const request = options();
    const result = await service.runLocal(template, input, request);
    expect(localRunner).toHaveBeenCalledWith(client, template, input, expect.objectContaining({ signal: request.signal }));
    expect(localRunner.mock.calls[0][1]).toBe(template); expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "failed", error: { message: "Synthetic local node is unavailable" } });
    const aborted = new AbortController(); aborted.abort();
    await expect(service.runLocal(template, input, { ...request, signal: aborted.signal })).rejects.toThrow();
    await expect(service.runRemote(template, input, { ...request, signal: aborted.signal })).rejects.toThrow();
    expect(localRunner).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
