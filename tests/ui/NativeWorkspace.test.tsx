import React from "react";
import { Text } from "ink";
import { render, cleanup } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/ui/App.js";
import { createNativeSessionsPanel } from "../../src/ui/NativeSessionsPanel.js";
import type { WorkspaceTaskService } from "../../src/ui/task-service.js";
import { SyntheticNativeAdapter } from "./fixtures/native-ui-scenario.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const service: WorkspaceTaskService = {
  detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [],
  getDemo: () => undefined, getConfig: () => ({}), getWorkflowInputs: () => [],
  executePattern: async () => "unused", executeWorkflow: async () => "unused", createWorkflow: () => "unused", updateDefaultModel: () => {},
};
afterEach(cleanup);

describe("native panel in the shared workspace", () => {
  it("uses native provider context and leaves native input and help keys with the panel", async () => {
    const adapter = new SyntheticNativeAdapter(); const panel = createNativeSessionsPanel({ adapter, workspace: "/synthetic/workspace" });
    const send = vi.spyOn(adapter, "sendInput"); const view = render(<App service={service} panels={[panel]} />);
    const press = async (value: string) => { view.stdin.write(value); await tick(); };
    await tick(); await press("\u001b"); for (let i = 0; i < 5; i++) await press("j"); await press("\r");
    expect(view.lastFrame()).toContain("synthetic-codex manages its own sign-in and permissions");
    expect(view.lastFrame()).not.toContain("No provider configured");
    await press("\r"); await press("\r"); await press("\r"); await press("why?q");
    expect(view.lastFrame()).toContain("why?q");
    expect(view.lastFrame()).not.toContain("Native session keys");
    await press("\r"); expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: "why?q" }));
    await panel.dispose?.();
  });

  it("awaits panel disposal after Ctrl+C before reporting workspace exit", async () => {
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.fn(() => pending); const onExit = vi.fn();
    const view = render(<App service={service} panels={[{ id: "owned", title: "Owned", description: "Owned resource", render: () => <Text>Owned</Text>, dispose }]} onExit={onExit} />);
    await tick(); view.stdin.write("\u0003"); await tick();
    expect(dispose).toHaveBeenCalledOnce(); expect(onExit).not.toHaveBeenCalled();
    release(); await tick(); expect(onExit).toHaveBeenCalledOnce();
  });

  it("attempts every panel teardown even when one throws synchronously", async () => {
    const onExit = vi.fn(); const otherDispose = vi.fn(async () => {});
    const view = render(<App service={service} onExit={onExit} panels={[
      { id: "throws", title: "Throws", description: "Synthetic", render: () => <Text>Fixture</Text>, dispose: () => { throw new Error("Synthetic cleanup failure"); } },
      { id: "other", title: "Other", description: "Synthetic", render: () => <Text>Fixture</Text>, dispose: otherDispose },
    ]} />);
    await tick(); view.stdin.write("q"); await tick();
    expect(otherDispose).toHaveBeenCalledOnce(); expect(onExit).toHaveBeenCalledOnce();
  });
});
