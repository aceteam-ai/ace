import { describe, expect, it } from "vitest";
import { PlatformTemplateController, platformReviewJson } from "../../src/ui/platform-template-controller.js";
import { SyntheticPlatformTemplates } from "./fixtures/platform-template-scenario.js";

async function ready(service = new SyntheticPlatformTemplates()) {
  const controller = new PlatformTemplateController(service); await controller.load(); await controller.open(controller.getSnapshot().templates[0]);
  return { controller, service };
}
describe("platform template operation ownership", () => {
  it("performs no I/O until opened and keeps catalog and reviewed values immutable", async () => {
    const service = new SyntheticPlatformTemplates(); const controller = new PlatformTemplateController(service);
    expect(service.listCalls).toEqual([]); expect(service.getCalls).toEqual([]); expect(service.runCalls).toEqual([]);
    await controller.load(); const summary = controller.getSnapshot().templates[0];
    await controller.open(summary); expect(service.getCalls[0].summary.versionNumber).toBe(3);
    const input = { prompt: "first", options: { values: [1, 2] } };
    const review = controller.review("remote", input); input.prompt = "changed"; input.options.values.push(3);
    expect(review.input).toEqual({ prompt: "first", count: 3, options: { values: [1, 2] } }); expect(Object.isFrozen(review.template.graph)).toBe(true);
    expect(review.text).toContain("stored version contents, which may change");
    const operation = controller.run(review); expect(controller.run(review)).toBe(operation); await operation;
    expect(service.runCalls).toHaveLength(1); expect(service.runCalls[0]).toMatchObject({ mode: "remote", input: review.input });
    expect(controller.getSnapshot().result?.status).toBe("completed");
    await controller.run(review); expect(service.runCalls).toHaveLength(1); await controller.dispose();
  });
  it("blocks both execution paths when the listed graph is inaccessible", async () => {
    const service = new SyntheticPlatformTemplates(); service.getError = new Error("403: This template graph is not accessible.");
    const { controller } = await ready(service);
    expect(controller.getSnapshot()).toMatchObject({ phase: "result", error: expect.stringContaining("403") });
    expect(() => controller.review("remote", {})).toThrow("accessible"); expect(() => controller.review("local", {})).toThrow("accessible");
    expect(service.runCalls).toEqual([]); await controller.dispose();
  });
  it("rejects a changed graph version and stale review after returning to the catalog", async () => {
    const { controller, service } = await ready(); const review = controller.review("local", {});
    controller.backToCatalog(); await controller.run(review); expect(service.runCalls).toEqual([]);
    const changed = new SyntheticPlatformTemplates(); changed.get = async () => ({ ...changed.template, versionNumber: 4 });
    const second = await ready(changed); expect(second.controller.getSnapshot().error).toContain("version changed");
    expect(changed.runCalls).toEqual([]); await controller.dispose(); await second.controller.dispose();
  });
  it("cancels before dispatch when a running-state listener closes the panel", async () => {
    const { controller, service } = await ready(); let closing: Promise<void> | undefined;
    controller.subscribe(() => { if (controller.getSnapshot().phase === "running") closing = controller.dispose(); });
    await controller.run(controller.review("remote", {})); await closing;
    expect(service.runCalls).toEqual([]); expect(controller.getSnapshot()).toMatchObject({ phase: "result", error: "Stopped before submission; no execution was started." });
  });
  it("waits for cleanup, retains job information, and never retries after abort", async () => {
    const service = new SyntheticPlatformTemplates(); let abortObserved = false; let finish!: () => void;
    service.execute = (call) => new Promise((_, reject) => {
      call.options.signal.addEventListener("abort", () => { abortObserved = true; finish = () => reject(new Error("Aborted")); });
    });
    const { controller } = await ready(service); const run = controller.run(controller.review("remote", {}));
    await Promise.resolve(); expect(service.runCalls).toHaveLength(1);
    const stop = controller.stop(); expect(abortObserved).toBe(true); expect(controller.getSnapshot().phase).toBe("stopping");
    let stopped = false; void stop.then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    finish(); await run; await stop;
    expect(controller.getSnapshot()).toMatchObject({ phase: "result", stopped: true, error: expect.stringContaining("may continue and consume credits") });
    expect(controller.getSnapshot().progress[0].jobId).toBe("synthetic-job"); expect(service.runCalls).toHaveLength(1); await controller.dispose();
  });
  it("retains run and job identities when progress rolls over and the transport fails", async () => {
    const service = new SyntheticPlatformTemplates();
    service.execute = async (call) => {
      call.options.onProgress({ message: "Started", runId: "known-run", jobId: "known-job" });
      for (let index = 0; index < 10; index++) call.options.onProgress({ message: `Node ${index}` });
      throw Object.assign(new Error("Outcome unknown; remote work may continue."), { jobId: "terminal-job" });
    };
    const { controller } = await ready(service); await controller.run(controller.review("remote", {}));
    expect(controller.getSnapshot()).toMatchObject({ phase: "result", runId: "known-run", jobId: "terminal-job", error: expect.stringContaining("unknown") });
    expect(controller.getSnapshot().progress).toHaveLength(6); expect(service.runCalls).toHaveLength(1);
    controller.backToCatalog(); expect(controller.getSnapshot().runId).toBeUndefined(); await controller.dispose();
  });
  it("validates and materializes defaults before review without gating remote runs on local node types", async () => {
    const service = new SyntheticPlatformTemplates(); service.template.graph.inner_nodes = [{ id: "remote-node", type: "RemoteOnlySynthetic", params: {} }];
    const { controller } = await ready(service);
    expect(() => controller.review("remote", { count: "bad" })).toThrow("integer"); expect(service.runCalls).toEqual([]);
    const review = controller.review("remote", {}); expect(JSON.parse(review.text).input).toEqual(review.input);
    expect(review.input).toMatchObject({ count: 3, options: { enabled: true, values: [1, 2] } });
    await controller.run(review); expect(service.runCalls[0].input).toEqual(review.input); await controller.dispose();
  });
  it("invalidates old reviews even when reopening returns the same cached template object", async () => {
    const { controller, service } = await ready(); const review = controller.review("remote", {});
    controller.backToCatalog(); await controller.open(controller.getSnapshot().templates[0]);
    expect(controller.getSnapshot().template).toBe(review.template);
    await controller.run(review); expect(service.runCalls).toEqual([]);
    await controller.run(controller.review("remote", {})); expect(service.runCalls).toHaveLength(1); await controller.dispose();
  });
  it.each(["completed", "failed", "cancelled", "error"] as const)("keeps authoritative %s settlement when a result listener disposes synchronously", async (status) => {
    const service = new SyntheticPlatformTemplates(); service.execute = async () => {
      if (status === "error") throw new Error("Known synthetic refusal");
      return { status, ...(status === "failed" ? { error: { message: "Known synthetic failure", workflowErrors: [], nodeErrors: {} } } : {}) };
    };
    const { controller } = await ready(service); let closing: Promise<void> | undefined;
    controller.subscribe(() => { if (controller.getSnapshot().phase === "result") closing = controller.dispose(); });
    await controller.run(controller.review("remote", {})); await closing;
    const state = controller.getSnapshot(); expect(state.phase).toBe("result"); expect(state.stopped).toBe(false);
    if (status === "error") expect(state.error).toBe("Known synthetic refusal");
    else { expect(state.result?.status).toBe(status); expect(state.error).toBeUndefined(); }
    expect(service.runCalls[0].options.signal.aborted).toBe(false); expect(service.runCalls).toHaveLength(1);
  });
  it("renders invisible JSON characters as explicit escapes without altering their values", () => {
    const input = { prompt: "before\u202eafter\u001b[2J\nnext\u007f\u0085\u009b31m" }; const rendered = platformReviewJson(input);
    expect(rendered).toContain("\\u202e"); expect(rendered).toContain("\\u001b"); expect(rendered).toContain("\\u007f"); expect(rendered).toContain("\\u0085"); expect(rendered).toContain("\\u009b"); expect(JSON.parse(rendered)).toEqual(input);
  });
});
