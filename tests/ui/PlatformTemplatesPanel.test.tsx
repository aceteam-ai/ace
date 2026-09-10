import React from "react";
import { render, cleanup } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as platformClient from "../../src/platform/client.js";
import { App } from "../../src/ui/App.js";
import { createPlatformTemplatesPanel } from "../../src/ui/PlatformTemplatesPanel.js";
import type { WorkspaceTaskService } from "../../src/ui/task-service.js";
import { SyntheticPlatformTemplates } from "./fixtures/platform-template-scenario.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const press = async (view: ReturnType<typeof render>, value: string) => { view.stdin.write(value); await tick(); };
const workspaceService: WorkspaceTaskService = {
  detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [], getDemo: () => undefined,
  getConfig: () => ({}), executePattern: async () => "", getWorkflowInputs: () => [], executeWorkflow: async () => "",
  createWorkflow: () => "", updateDefaultModel: () => {},
};
const panels: Array<ReturnType<typeof createPlatformTemplatesPanel>> = [];
afterEach(async () => { cleanup(); await Promise.all(panels.splice(0).map((panel) => panel.dispose?.())); });
async function enter(service = new SyntheticPlatformTemplates(), columns = 80, rows = 24) {
  const panel = createPlatformTemplatesPanel({ service }); panels.push(panel);
  const view = render(<App service={workspaceService} panels={[panel]} />);
  Object.defineProperty(view.stdout, "columns", { value: columns, configurable: true });
  Object.defineProperty(view.stdout, "rows", { value: rows, configurable: true }); view.stdout.emit("resize");
  await tick(); expect(service.listCalls).toEqual([]);
  await press(view, "\u001b"); for (let i = 0; i < 5; i++) await press(view, "j"); await press(view, "\r");
  await vi.waitFor(() => expect(service.listCalls).toHaveLength(1));
  return { service, view, panel };
}
async function inputs(view: ReturnType<typeof render>) {
  await press(view, "summary"); await press(view, "\r");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("Selected version: 3"));
  await press(view, "\r");
}
async function defaults(view: ReturnType<typeof render>) { for (let i = 0; i < 3; i++) await press(view, "\r"); }
async function readAll(view: ReturnType<typeof render>, marker: string) {
  let pages = 0;
  while (!view.lastFrame()?.includes(marker) && pages++ < 150) await press(view, "\u001b[6~");
  expect(view.lastFrame()).toContain(marker);
}

describe("platform templates in the shared terminal", () => {
  it("advertises the production panel without resolving credentials or creating a client", async () => {
    const create = vi.spyOn(platformClient, "createPlatformClientFromConfig").mockRejectedValue(new Error("Unexpected platform I/O"));
    const panel = createPlatformTemplatesPanel(); panels.push(panel);
    try {
      const view = render(<App service={workspaceService} panels={[panel]} />); await tick(); await press(view, "\u001b");
      expect(view.lastFrame()).toContain("Platform templates"); expect(create).not.toHaveBeenCalled();
    } finally { create.mockRestore(); }
  });
  it("loads only on entry and filters grouped metadata without starting runtime or execution", async () => {
    const { service, view } = await enter();
    expect(view.lastFrame()).toContain("[Analysis]"); expect(view.lastFrame()).toContain("[General]");
    await press(view, "summary"); expect(view.lastFrame()).toContain("1 templates"); expect(view.lastFrame()).not.toContain("Synthetic analysis");
    await press(view, "\t"); expect(view.lastFrame()).toContain("No matching templates");
    await press(view, "\t"); expect(view.lastFrame()).toContain("Synthetic summary");
    expect(service.listCalls).toHaveLength(1); expect(service.getCalls).toEqual([]); expect(service.runCalls).toEqual([]);
    await press(view, "\r"); expect(service.getCalls[0].summary.versionNumber).toBe(3); expect(service.runCalls).toEqual([]);
  });
  it("preserves typed defaults and structured input through explicit remote review, with no implicit or duplicate submission", async () => {
    const { service, view } = await enter(); await inputs(view);
    await press(view, "\r"); expect(view.lastFrame()).toContain("Type: integer");
    await press(view, "oops"); await press(view, "\r"); expect(view.lastFrame()).toContain("Enter valid JSON");
    for (let i = 0; i < 4; i++) await press(view, "\u007f");
    await press(view, "\r"); await press(view, '{"enabled":false,\n"values":[4,5]}'); await press(view, "\r");
    expect(view.lastFrame()).toContain("Choose where to execute"); await press(view, "\u001b[B"); await press(view, "\r");
    expect(service.runCalls).toEqual([]); await press(view, "\r"); expect(service.runCalls).toEqual([]);
    await press(view, "y"); expect(service.runCalls).toEqual([]);
    await readAll(view, "y Submit platform run (uses credits)");
    view.stdin.write("y"); view.stdin.write("y"); await vi.waitFor(() => expect(service.runCalls).toHaveLength(1));
    expect(service.runCalls[0]).toMatchObject({ mode: "remote", template: { versionNumber: 3 },
      input: { prompt: "Synthetic default", count: 3, options: { enabled: false, values: [4, 5] } } });
    await vi.waitFor(() => expect(view.lastFrame()).toContain("Completed"));
  });
  it.each([40, 48])("keeps every reviewed line and credit confirmation inside the full App at %i×24", async (columns) => {
    const service = new SyntheticPlatformTemplates();
    const text = `${"Read this synthetic line.\n".repeat(50)}VISIBLE LAST INPUT LINE`;
    service.template.graph.input_node.params.fields.prompt.default = text;
    const { view } = await enter(service, columns); await inputs(view); await defaults(view);
    await press(view, "\u001b[B"); await press(view, "\r"); await press(view, "y"); expect(service.runCalls).toEqual([]);
    let pages = 0; let lastSeen = false;
    while (!view.lastFrame()?.includes("y Submit platform run (uses credits)") && pages++ < 150) {
      expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(24);
      lastSeen ||= view.lastFrame()!.replace(/\s/g, "").includes("VISIBLELASTINPUTLINE"); await press(view, "\u001b[6~");
    }
    lastSeen ||= view.lastFrame()!.replace(/\s/g, "").includes("VISIBLELASTINPUTLINE");
    expect(lastSeen).toBe(true); expect(view.lastFrame()).toContain("y Submit platform run (uses credits)");
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(24);
    Object.defineProperty(view.stdout, "rows", { value: 12, configurable: true }); view.stdout.emit("resize"); await tick();
    await press(view, "y"); expect(service.runCalls).toEqual([]);
    Object.defineProperty(view.stdout, "rows", { value: 24, configurable: true }); view.stdout.emit("resize"); await tick();
    await readAll(view, "y Submit platform run (uses credits)"); await press(view, "y");
    expect(service.runCalls[0].input.prompt).toBe(text);
  });
  it("shows escaped control characters in the full review and reports redacted errors as failures", async () => {
    const service = new SyntheticPlatformTemplates(); const prompt = "visible\u007f\u0085\u009b31m";
    service.template.graph.input_node.params.fields.prompt.default = prompt;
    service.execute = async () => ({ status: "failed", error: { workflowErrors: [null], nodeErrors: {} } });
    const { view } = await enter(service); await inputs(view); await defaults(view); await press(view, "\u001b[B"); await press(view, "\r");
    let pages = 0; let review = "";
    while (!view.lastFrame()?.includes("y Submit platform run") && pages++ < 40) { review += view.lastFrame(); await press(view, "\u001b[6~"); }
    review += view.lastFrame(); expect(review).toContain("\\u007f\\u0085\\u009b31m");
    await press(view, "y"); expect(service.runCalls[0].input.prompt).toBe(prompt);
    expect(view.lastFrame()).toContain("Execution failed"); expect(view.lastFrame()).toContain("reported an execution error");
  });
  it("shows inaccessible-graph errors and blocks local and remote actions", async () => {
    const service = new SyntheticPlatformTemplates(); service.getError = new Error("This listed template graph is unavailable for this platform connection.");
    const { view } = await enter(service); await press(view, "summary"); await press(view, "\r");
    expect(view.lastFrame()).toContain("Could not complete"); expect(view.lastFrame()).toContain("unavailable for this");
    await press(view, "y"); expect(service.runCalls).toEqual([]);
  });
  it("stops observation on Escape during remote work, waits for cleanup, and preserves the uncertain outcome", async () => {
    const service = new SyntheticPlatformTemplates(); let finish!: () => void;
    service.execute = (call) => new Promise((_, reject) => { call.options.signal.addEventListener("abort", () => { finish = () => reject(new Error("Stopped")); }); });
    const { view } = await enter(service); await inputs(view); await defaults(view); await press(view, "\u001b[B"); await press(view, "\r");
    await readAll(view, "y Submit platform run (uses credits)"); await press(view, "y");
    expect(service.runCalls).toHaveLength(1); await press(view, "\u001b"); expect(view.lastFrame()).toContain("Waiting for cleanup");
    expect(service.runCalls[0].options.signal.aborted).toBe(true); await press(view, "y"); expect(service.runCalls).toHaveLength(1);
    finish(); await vi.waitFor(() => expect(view.lastFrame()).toContain("Observation stopped"));
    expect(view.lastFrame()).toContain("may continue and consume credits"); expect(view.lastFrame()).toContain("synthetic-job");
  });
  it("paginates complete multiline Markdown output and explicitly chooses local execution", async () => {
    const service = new SyntheticPlatformTemplates(); service.execute = async (call) => ({ status: "completed", workflowVersionId: call.template.workflowVersionId,
      output: { response: `# Synthetic heading\n\n${"Long output line\n".repeat(50)}FINAL OUTPUT LINE` } });
    const { view } = await enter(service, 40); await inputs(view); await defaults(view); await press(view, "\r");
    await readAll(view, "y Run locally"); await press(view, "y"); expect(service.runCalls[0].mode).toBe("local");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("Synthetic heading"));
    await readAll(view, "FINAL OUTPUT LINE"); expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(24);
  });
});
