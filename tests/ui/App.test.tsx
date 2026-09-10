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

  it("strips terminal control sequences from results", async () => {
    const view = render(<App service={service({ detectProvider: async () => ({ provider: "openai" }), executePattern: async () => "safe\u001b]8;;https://bad.invalid\u0007link\u001b]8;;\u0007" })} />);
    await tick();
    view.stdin.write("\r"); await tick(); view.stdin.write("hello"); await tick(); view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("safelink");
    expect(view.lastFrame()).not.toContain("bad.invalid");
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
      getWorkflowInputs: vi.fn(() => ["prompt"]),
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
    expect(view.lastFrame()).toContain("Input: prompt");
    view.stdin.write("hello");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(executeWorkflow).toHaveBeenCalledWith("flow.json", { prompt: "hello" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
