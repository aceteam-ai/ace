import React from "react";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/ui/App.js";
import type { WorkspaceTaskService } from "../../src/ui/task-service.js";
import { BUILTIN_PATTERNS } from "../../src/patterns/index.js";
import { TEMPLATES } from "../../src/templates/index.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
function service(overrides: Partial<WorkspaceTaskService> = {}): WorkspaceTaskService {
  return {
    detectProvider: vi.fn(async () => ({ provider: null })),
    listPatterns: () => BUILTIN_PATTERNS,
    listTemplates: () => TEMPLATES,
    getDemo: (id) => id === "summarize" ? { input: "A matching sample input", output: "A prerecorded sample output" } : undefined,
    getConfig: () => ({}),
    executePattern: vi.fn(async () => "live output"),
    getWorkflowInputs: vi.fn(() => []),
    executeWorkflow: vi.fn(async () => "workflow output"),
    createWorkflow: vi.fn(() => "created"),
    updateDefaultModel: vi.fn(),
    ...overrides,
  };
}
afterEach(cleanup);

describe("terminal workspace", () => {
  it("paints the focused task picker before provider detection resolves", () => {
    const pending = new Promise<never>(() => {});
    const view = render(<App service={service({ detectProvider: () => pending })} />);
    expect(view.lastFrame()).toContain("Choose a task");
    expect(view.lastFrame()).toContain("Checking providers");
  });

  it("shows an honest matching demo without starting a live run", async () => {
    const fake = service();
    const view = render(<App service={fake} />);
    for (let i = 0; i < 10 && !view.lastFrame()?.includes("No provider configured"); i++) await tick();
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("Prerecorded sample");
    expect(view.lastFrame()).toContain("A matching sample input");
    expect(view.lastFrame()).toContain("A prerecorded sample output");
    expect(fake.executePattern).not.toHaveBeenCalled();
  });

  it("keeps typed question marks and uses Tab for input help", async () => {
    const fake = service({ detectProvider: async () => ({ provider: "openai", model: "gpt-test" }) });
    const view = render(<App service={fake} />);
    await tick();
    view.stdin.write("\r");
    await tick();
    view.stdin.write("why?");
    await tick();
    expect(view.lastFrame()).toContain("why?");
    view.stdin.write("\t");
    expect(view.lastFrame()).toContain("Keys");
    view.stdin.write("\t");
    expect(view.lastFrame()).toContain("why?");
  });

  it("keeps long task input bounded while submitting the complete value", async () => {
    const executePattern = vi.fn(async () => "done");
    const view = render(<App service={service({ detectProvider: async () => ({ provider: "openai" }), executePattern })} />);
    await tick();
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 48 });
    Object.defineProperty(view.stdout, "rows", { configurable: true, value: 12 });
    view.stdout.emit("resize");
    await tick(); view.stdin.write("\r"); await tick();
    const input = "hidden-prefix-" + "x".repeat(160) + "-visible-tail";
    view.stdin.write(input); await tick();
    expect(view.lastFrame()).toContain("visible-tail");
    expect(view.lastFrame()).not.toContain("hidden-prefix");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(12);
    view.stdin.write("\r"); await tick();
    expect(executePattern).toHaveBeenCalledWith("summarize", input, expect.any(Object));
  });

  it("cancels a live run and returns a bounded result screen", async () => {
    const executePattern = vi.fn((_id: string, _input: string, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("cancelled"); error.name = "AbortError"; reject(error);
      });
    }));
    const view = render(<App service={service({ detectProvider: async () => ({ provider: "openai" }), executePattern: executePattern as WorkspaceTaskService["executePattern"] })} />);
    await tick();
    view.stdin.write("\r");
    await tick();
    view.stdin.write("hello");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("Working");
    view.stdin.write("\u001b");
    await tick();
    expect(view.lastFrame()).toContain("Run cancelled");
    expect(executePattern).toHaveBeenCalledOnce();
  });


  it("waits for active work to acknowledge shutdown before exiting", async () => {
    const shutdown = new AbortController();
    const onExit = vi.fn();
    const executePattern: WorkspaceTaskService["executePattern"] = (_id, _input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => setTimeout(() => {
        const error = new Error("cancelled"); error.name = "AbortError"; reject(error);
      }, 20));
    });
    const view = render(<App service={service({ detectProvider: async () => ({ provider: "openai" }), executePattern })} shutdownSignal={shutdown.signal} onExit={onExit} />);
    await tick(); view.stdin.write("\r"); await tick(); view.stdin.write("work"); await tick(); view.stdin.write("\r"); await tick();
    shutdown.abort();
    expect(onExit).not.toHaveBeenCalled();
    await tick();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("reflows result pages on height-only resize and clamps stale scroll offsets", async () => {
    const output = "BEGIN-" + "x".repeat(1100) + "-VISIBLE-END";
    const view = render(<App service={service({ detectProvider: async () => ({ provider: "openai" }), executePattern: async () => output })} />);
    await tick(); view.stdin.write("\r"); await tick(); view.stdin.write("go"); await tick(); view.stdin.write("\r"); await tick();

    Object.defineProperty(view.stdout, "rows", { configurable: true, value: 12 });
    view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("↑/↓ Scroll");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(12);

    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 48 });
    view.stdout.emit("resize"); await tick();
    for (let i = 0; i < 10; i++) { view.stdin.write("j"); await tick(); }
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 200 });
    view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("VISIBLE-END");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("strips terminal control sequences from results", async () => {
    const view = render(<App service={service({ detectProvider: async () => ({ provider: "openai" }), executePattern: async () => "safe\u001b]8;;https://bad.invalid\u0007link\u001b]8;;\u0007" })} />);
    await tick();
    view.stdin.write("\r"); await tick(); view.stdin.write("hello"); await tick(); view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("safelink");
    expect(view.lastFrame()).not.toContain("bad.invalid");
  });



  it("sanitizes settings values and reports save failures in the workspace", async () => {
    const fake = service({
      getConfig: () => ({ default_model: "safe\u001b]8;;https://bad.invalid\u0007model\u001b]8;;\u0007" }),
      updateDefaultModel: () => { throw new Error("settings are read-only"); },
    });
    const view = render(<App service={fake} />);
    await tick(); view.stdin.write("\u001b"); await tick();
    for (let i = 0; i < 3; i++) { view.stdin.write("j"); await tick(); }
    view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("safemodel");
    expect(view.lastFrame()).not.toContain("bad.invalid");
    view.stdin.write("e"); await tick(); view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("settings are read-only");
  });

  it("quits directly from the initial task picker", async () => {
    const onExit = vi.fn();
    const view = render(<App service={service()} onExit={onExit} />);
    await tick();
    view.stdin.write("q");
    await tick();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("collects declared workflow inputs before starting a live run", async () => {
    const executeWorkflow = vi.fn(async () => "done");
    const fake = service({
      getWorkflowInputs: vi.fn(() => [{ name: "prompt", schema: { type: "string" }, required: true }]),
      executeWorkflow,
    });
    const view = render(<App service={fake} />);
    await tick();
    view.stdin.write("\u001b");
    await tick();
    view.stdin.write("j");
    await tick();
    view.stdin.write("\r");
    await tick();
    view.stdin.write("flow.json");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("prompt");
    view.stdin.write("hello");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(executeWorkflow).toHaveBeenCalledWith("flow.json", { prompt: "hello" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });


  it("filters local templates and pages full details on a 48x12 terminal", async () => {
    const view = render(<App service={service()} />);
    await tick();
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 48 });
    Object.defineProperty(view.stdout, "rows", { configurable: true, value: 12 });
    view.stdout.emit("resize");
    await tick();
    view.stdin.write("\u001b"); await tick();
    view.stdin.write("j"); await tick();
    view.stdin.write("j"); await tick();
    view.stdin.write("\r"); await tick();
    view.stdin.write("api"); await tick();
    expect(view.lastFrame()).toContain("API to LLM");
    expect(view.lastFrame()).not.toContain("Hello LLM");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(12);
    view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("Authoring example only");
    for (let i = 0; i < 8; i++) { view.stdin.write("j"); await tick(); }
    expect(view.lastFrame()).toContain("Input schema");
    expect(view.lastFrame()).toContain("URL");
    expect(view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("sanitizes workflow schema type labels before rendering", async () => {
    const fake = service({
      getWorkflowInputs: () => [{
        name: "count",
        schema: { type: "integer\u001b]8;;https://bad.invalid\u0007value\u001b]8;;\u0007" },
        required: true,
      }],
    });
    const view = render(<App service={fake} />);
    await tick(); view.stdin.write("\u001b"); await tick(); view.stdin.write("j"); await tick(); view.stdin.write("\r"); await tick();
    view.stdin.write("flow.json"); await tick(); view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("integervalue");
    expect(view.lastFrame()).not.toContain("bad.invalid");
  });

  it("keeps typed workflow validation errors on the form and submits JSON values/defaults", async () => {
    const executeWorkflow = vi.fn(async () => "# Result\n- complete");
    const fake = service({
      getWorkflowInputs: () => [
        { name: "count", schema: { type: "integer", description: "How many" }, required: true },
        { name: "enabled", schema: { type: "boolean", default: true }, required: false },
        { name: "note", schema: { type: "string", required: false, default: "" }, required: false },
      ],
      executeWorkflow,
    });
    const view = render(<App service={fake} />);
    await tick(); view.stdin.write("\u001b"); await tick(); view.stdin.write("j"); await tick(); view.stdin.write("\r"); await tick();
    view.stdin.write("flow.json"); await tick(); view.stdin.write("\r"); await tick();
    view.stdin.write("wrong"); await tick(); view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("valid JSON");
    for (let i = 0; i < 5; i++) { view.stdin.write("\u007f"); await tick(); }
    view.stdin.write("3"); await tick(); view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("Enter uses true");
    view.stdin.write("\r"); await tick();
    expect(view.lastFrame()).toContain("default available");
    view.stdin.write("\r"); await tick();
    expect(executeWorkflow).toHaveBeenCalledWith("flow.json", { count: 3, enabled: true, note: "" }, expect.any(Object));
    expect(view.lastFrame()).toContain("Result");
    expect(view.lastFrame()).toContain("• complete");
  });

  it("leaves Enter handling to extension panels", async () => {
    const view = render(<App service={service()} panels={[{ id: "native", title: "Native", description: "Native session", render: () => <Text>Native panel owns Enter</Text> }]} />);
    await tick();
    view.stdin.write("\u001b");
    for (let i = 0; i < 5; i++) { view.stdin.write("j"); await tick(); }
    view.stdin.write("\r");
    expect(view.lastFrame()).toContain("Native panel owns Enter");
    view.stdin.write("\r");
    expect(view.lastFrame()).toContain("Native panel owns Enter");
  });
});
