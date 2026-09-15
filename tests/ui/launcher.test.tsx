import React from "react";
import { Text } from "ink";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, cleanup } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/ui/App.js";
import { findOnPath, loadHarnesses, runLauncherAction, saveHarnessArgs, type LauncherAction } from "../../src/launcher.js";
import type { WorkspaceTaskService } from "../../src/ui/task-service.js";

const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
function service(): WorkspaceTaskService {
  return {
    detectProvider: async () => ({ provider: "openai", model: "test-model" }),
    listPatterns: () => [], listTemplates: () => [], getDemo: () => undefined,
    getConfig: () => ({}), executePattern: async () => "", getWorkflowInputs: () => [],
    executeWorkflow: vi.fn(async (_path, input) => JSON.stringify({ response: `Reply to ${String(input.prompt).slice(-30)}` })),
    createWorkflow: () => "", updateDefaultModel: () => {},
  };
}
const initialPath = process.env.PATH;
afterEach(() => { cleanup(); process.env.PATH = initialPath; });

describe("bare ace launcher", () => {
  it("opens Chat, Code, Work, and harness routes", async () => {
    const view = render(<App launcher service={service()} panels={[{ id: "native", title: "Coding", description: "Coding", render: () => <Text>Native chooser</Text> }]} />);
    expect(view.lastFrame()).toContain("Ace launcher");
    expect(view.lastFrame()).toContain("Chat");
    expect(view.lastFrame()).toContain("Code");
    expect(view.lastFrame()).toContain("Work");
    expect(view.lastFrame()).toContain("Launch Claude Code");
    await delay(); view.stdin.write("\u001b[B"); await delay(); expect(view.lastFrame()).toContain("❯ Code"); view.stdin.write("\r"); await delay(); expect(view.lastFrame()).toContain("Native chooser");
  });

  it("keeps chat turns in the local workflow and preserves context", async () => {
    const fake = service();
    const view = render(<App launcher service={fake} />);
    await delay(); view.stdin.write("\r"); await delay();
    view.stdin.write("hello"); await delay(); view.stdin.write("\r"); await delay();
    expect(view.lastFrame()).toContain("Reply to");
    view.stdin.write("again"); await delay(); view.stdin.write("\r"); await delay();
    expect(fake.executeWorkflow).toHaveBeenCalledTimes(2);
    const second = vi.mocked(fake.executeWorkflow).mock.calls[1][1];
    expect(second.prompt).toContain("You: hello");
    expect(second.prompt).toContain("You: again");
  });

  it("opens configuration from the first screen with right arrow", async () => {
    const view = render(<App launcher service={service()} />);
    await delay();
    for (let i = 0; i < 3; i++) { view.stdin.write("\u001b[B"); await delay(); }
    view.stdin.write("\u001b[C"); await delay();
    expect(view.lastFrame()).toContain("Claude Code configuration");
    expect(view.lastFrame()).toContain("JSON array");
    view.stdin.write("\u001b"); await delay();
    expect(view.lastFrame()).toContain("Ace launcher");
  });

  it("offers an absent harness installer on Enter and exits before the action", async () => {
    process.env.PATH = "";
    const action = vi.fn<(action: LauncherAction) => void>();
    const onExit = vi.fn();
    const view = render(<App launcher service={service()} onExternalAction={action} onExit={onExit} />);
    await delay(); for (let i = 0; i < 3; i++) { view.stdin.write("\u001b[B"); await delay(); }
    expect(view.lastFrame()).toContain("❯ Launch Claude Code");
    view.stdin.write("\r"); await delay();
    view.stdin.write("\r"); await delay();
    expect(action).toHaveBeenCalledOnce();
    expect(action.mock.calls[0][0]).toMatchObject({ kind: "install", harness: { id: "claude" } });
    expect(onExit).toHaveBeenCalledOnce();
  });
});

describe("harness manifest and child process", () => {
  it("merges a custom registry, saves argv, and rejects invalid records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ace-launcher-test-"));
    try {
      const path = join(dir, "registry.json");
      const custom = { id: "dummy", name: "Dummy", description: "Fixture", detect: "dummy", launch: { command: "dummy", args: [] } };
      writeFileSync(path, JSON.stringify([custom]));
      expect(loadHarnesses(path).some((entry) => entry.id === "dummy")).toBe(true);
      saveHarnessArgs(custom, ["--model", "m one"], path);
      expect(loadHarnesses(path).find((entry) => entry.id === "dummy")?.launch.args).toEqual(["--model", "m one"]);
      expect(JSON.parse(readFileSync(path, "utf8"))[0].launch.args).toEqual(["--model", "m one"]);
      writeFileSync(path, JSON.stringify([{ ...custom, launch: { command: "dummy", args: "$(bad)" } }]));
      expect(() => loadHarnesses(path)).toThrow("Invalid launcher registry");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("passes arguments literally to a local executable without a shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ace-launcher-bin-"));
    try {
      mkdirSync(join(dir, "bin"));
      const binary = join(dir, "bin", "dummy");
      const output = join(dir, "args.json");
      writeFileSync(binary, `#!/usr/bin/env node\nrequire('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))\n`, { mode: 0o755 });
      expect(findOnPath("dummy", join(dir, "bin"))).toBe(binary);
      const action: LauncherAction = { kind: "launch", harness: { id: "dummy", name: "Dummy", description: "Fixture", detect: binary, launch: { command: binary, args: [output, "$(touch bad)", "two words"] } } };
      expect(await runLauncherAction(action)).toBe(0);
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["$(touch bad)", "two words"]);
      expect(findOnPath("bad", dir)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
