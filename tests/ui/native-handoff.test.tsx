import React from "react";
import { render, cleanup } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeNativeHarnessAdapter } from "../../src/harness/fake.js";
import { parseHandoffReview } from "../../src/harness/handoff.js";
import { NativeSessionManager } from "../../src/harness/session-manager.js";
import { NativeSessionStore } from "../../src/harness/session-store.js";
import { NativeWorkspaceController } from "../../src/ui/native-workspace-controller.js";
import { NativeHandoffPanel } from "../../src/ui/NativeHandoffPanel.js";
import { ManagedNativeWorkspace } from "../../src/ui/ManagedNativeWorkspace.js";

let root: string; let workspace: string; let controller: NativeWorkspaceController;
let natives: FakeNativeHarnessAdapter[];
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const envelope = (summary = "Review the synthetic work.") => ({ version: 1, summary, artifacts: [{ path: "unread-artifact.ts", label: "Reference only" }], target: { adapterId: "claude", workspace } });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-handoff-ui-")); workspace = join(root, "workspace"); await mkdir(workspace); natives = [];
  const factory = (adapterId: string) => () => { const native = new FakeNativeHarnessAdapter({ adapterId, turnIdentity: adapterId === "claude" ? "local" : "native" }); natives.push(native); return native; };
  controller = new NativeWorkspaceController(new NativeSessionManager({ store: new NativeSessionStore({ directory: join(root, "state") }), adapters: { codex: factory("codex"), claude: factory("claude") } }));
});
afterEach(async () => { cleanup(); await controller.dispose(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const press = async (view: ReturnType<typeof render>, value: string) => { view.stdin.write(value); await tick(); };

async function reviewScreen(summary?: string) {
  const path = join(root, "handoff.json"); await writeFile(path, JSON.stringify(envelope(summary)));
  const back = vi.fn(); const opened = vi.fn(); const view = render(<NativeHandoffPanel controller={controller} back={back} opened={opened} />);
  await tick(); await press(view, path); await press(view, "\r");
  return { path, view, back, opened };
}

describe("managed handoff execution", () => {
  it("starts one new session and submits the immutable input once despite duplicate confirmation", async () => {
    const review = await parseHandoffReview(JSON.stringify(envelope()));
    expect(natives).toEqual([]);
    const pending = controller.confirmHandoff(review);
    expect(controller.confirmHandoff(review)).toBe(pending);
    expect(await pending).toMatchObject({ status: "ok" });
    const service = controller.selectedService!;
    expect(service.getSnapshot().messages.map((item) => item.text)).toEqual([review.input]);
    const resume = vi.spyOn(natives[0], "resume");
    expect(await controller.confirmHandoff(review)).toMatchObject({ status: "ok" });
    expect(natives).toHaveLength(1); expect(resume).not.toHaveBeenCalled();
    expect(service.getSnapshot().messages).toHaveLength(1);
  });

  it("requires explicit closure of any existing session and rejects unknown-outcome retries", async () => {
    const existing = controller.select("codex"); await existing.start(workspace);
    const review = await parseHandoffReview(JSON.stringify(envelope()));
    expect(await controller.confirmHandoff(review)).toMatchObject({ status: "rejected" });
    expect(natives).toHaveLength(1);
    await existing.close();
    const next = await parseHandoffReview(JSON.stringify(envelope()));
    const target = controller.select("claude");
    const send = vi.spyOn(natives.at(-1)!, "sendInput").mockResolvedValueOnce({ status: "error", code: "unknown", message: "Synthetic unknown outcome" });
    expect(await controller.confirmHandoff(next)).toMatchObject({ status: "error" });
    expect(await controller.confirmHandoff(next)).toMatchObject({ status: "error" });
    expect(send).toHaveBeenCalledOnce(); expect(target.getSnapshot().phase).toBe("error");
  });

  it("blocks input inserted by readiness listeners during a confirmed handoff", async () => {
    const target = controller.select("claude"); const send = vi.spyOn(natives[0], "sendInput");
    let inserted: Promise<unknown> | undefined;
    target.subscribe(() => { if (target.getSnapshot().phase === "ready" && !inserted) inserted = target.sendInput("unreviewed injection"); });
    const review = await parseHandoffReview(JSON.stringify(envelope()));
    expect(await controller.confirmHandoff(review)).toMatchObject({ status: "ok" });
    expect(await inserted).toMatchObject({ status: "rejected" });
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0][0].input).toBe(review.input);
  });

  it.each(["before-start", "after-start"] as const)("detects replaced workspace %s and submits no input", async (when) => {
    const review = await parseHandoffReview(JSON.stringify(envelope()));
    const target = controller.select("claude"); const native = natives[0]; const send = vi.spyOn(native, "sendInput");
    const replace = async () => { await rename(workspace, join(root, "old-workspace")); await mkdir(workspace); };
    if (when === "before-start") await replace();
    else { const start = native.start.bind(native); vi.spyOn(native, "start").mockImplementation(async (command) => { const result = await start(command); await replace(); return result; }); }
    expect(await controller.confirmHandoff(review)).toMatchObject({ status: "error" });
    expect(send).not.toHaveBeenCalled(); expect(target.getSnapshot().notice).toContain("workspace changed");
  });

  it("honors close during handoff readiness without submitting input", async () => {
    const target = controller.select("claude"); const send = vi.spyOn(natives[0], "sendInput");
    let closing: Promise<void> | undefined;
    target.subscribe(() => { if (target.getSnapshot().phase === "ready" && !closing) closing = target.close(); });
    const review = await parseHandoffReview(JSON.stringify(envelope()));
    expect(await controller.confirmHandoff(review)).toMatchObject({ status: "rejected" });
    await closing; expect(send).not.toHaveBeenCalled();
  });
});

describe("handoff and provider review UI", () => {
  it("selects between managed providers without creating a native process before explicit start", async () => {
    const view = render(<ManagedNativeWorkspace controller={controller} workspace={workspace} back={() => {}} />); await tick();
    expect(view.lastFrame()).toContain("❯ Codex"); expect(view.lastFrame()).toContain("Claude Agent"); expect(natives).toEqual([]);
    await press(view, "\u001b[B"); await press(view, "\r");
    expect(view.lastFrame()).toContain("Claude Agent workspace directory");
    const start = vi.spyOn(natives[0], "start"); expect(start).not.toHaveBeenCalled();
    await press(view, "\r"); expect(view.lastFrame()).toContain("Start new session"); expect(start).not.toHaveBeenCalled();
    await press(view, "\r"); expect(start).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(view.lastFrame()).toContain("Claude Agent · Ready")); expect(view.lastFrame()).not.toContain("Sandbox:");
  });

  it("displays all 16 KiB of summary before enabling confirmation and sends only the reviewed snapshot", async () => {
    const summary = `${"a".repeat(16 * 1024 - 24)}VISIBLE END OF SUMMARY`;
    const { view, path, opened } = await reviewScreen(summary);
    expect(view.lastFrame()).toContain("Read all pages");
    await press(view, "y"); await press(view, "\r"); expect(natives).toEqual([]);
    const review = await parseHandoffReview(JSON.stringify(envelope(summary)));
    await writeFile(path, JSON.stringify(envelope("UNREVIEWED REPLACEMENT")));
    let pages = 0; let endVisible = false;
    while (!view.lastFrame()!.includes("y Confirm once") && pages++ < 80) {
      await press(view, "\u001b[6~"); endVisible ||= view.lastFrame()!.includes("VISIBLE END OF SUMMARY");
    }
    expect(endVisible).toBe(true); expect(pages).toBeLessThan(80);
    view.stdin.write("y"); view.stdin.write("y"); await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(controller.selectedService!.getSnapshot().messages.map((item) => item.text)).toEqual([review.input]);
    expect(controller.selectedService!.getSnapshot().messages[0].text).not.toContain("REPLACEMENT");
  });

  it("declines without constructing a provider and pauses confirmation on small terminals", async () => {
    const { view, back } = await reviewScreen();
    Object.defineProperty(view.stdout, "columns", { value: 48, configurable: true }); Object.defineProperty(view.stdout, "rows", { value: 12, configurable: true }); view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("Confirmation paused"); await press(view, "y"); expect(natives).toEqual([]);
    Object.defineProperty(view.stdout, "rows", { value: 24, configurable: true }); view.stdout.emit("resize"); await tick();
    await press(view, "n"); expect(back).toHaveBeenCalledOnce(); expect(natives).toEqual([]);
  });
});

it.each([40, 48])("keeps the full App-wrapped review and confirmation visible at %i×24, including an outcome notice", async (columns) => {
  const { App } = await import("../../src/ui/App.js");
  const path = join(root, "handoff.json");
  await writeFile(path, JSON.stringify(envelope("Review this complete synthetic summary.\n".repeat(8))));
  const view = render(<App service={{ detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [],
    getDemo: () => undefined, getConfig: () => ({}), getWorkflowInputs: () => [], executePattern: async () => "unused", executeWorkflow: async () => "unused",
    createWorkflow: () => "unused", updateDefaultModel: () => {} }} panels={[{ id: "review", title: "Review", description: "Synthetic local handoff",
    providerLabel: "Native session handoff", dispose: () => controller.dispose(),
    render: () => <NativeHandoffPanel controller={controller} back={() => {}} opened={() => {}} /> }]} />);
  Object.defineProperty(view.stdout, "columns", { value: columns, configurable: true }); Object.defineProperty(view.stdout, "rows", { value: 24, configurable: true }); view.stdout.emit("resize");
  await tick(); await press(view, "\u001b"); for (let index = 0; index < 5; index++) await press(view, "j"); await press(view, "\r");
  await press(view, path); await press(view, "\r");
  expect(view.lastFrame()).toContain("Review a new-session handoff");
  let pages = 0;
  do {
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(24);
    expect(view.lastFrame()).toContain("Enter never confirms. Esc Cancel");
    if (view.lastFrame()!.includes("y Confirm once")) break;
    await press(view, "\u001b[6~");
  } while (++pages < 20);
  expect(view.lastFrame()).toContain("y Confirm once");
  vi.spyOn(controller, "confirmHandoff").mockRejectedValueOnce(new Error("Synthetic unknown outcome"));
  await press(view, "y");
  expect(view.lastFrame()).toContain("outcome is unknown");
  expect(view.lastFrame()).toContain("No automatic retry. Esc Back");
  expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(24);
  expect(natives).toEqual([]);
});


it("keeps a failed handoff visible instead of routing to an older selected service", async () => {
  const old = controller.select("codex"); await old.start(workspace); await old.close();
  const { view, opened } = await reviewScreen();
  let pages = 0;
  while (!view.lastFrame()!.includes("y Confirm once") && pages++ < 10) await press(view, "\u001b[6~");
  const select = controller.select.bind(controller);
  vi.spyOn(controller, "select").mockImplementation((provider) => { if (provider === "claude") throw new Error("Synthetic unavailable factory"); return select(provider); });
  await press(view, "y");
  expect(opened).not.toHaveBeenCalled();
  expect(view.lastFrame()).toContain("handoff provider is unavailable");
  expect(view.lastFrame()).toContain("No automatic retry. Esc Back");
  expect(controller.selectedService).toBe(old);
  expect(natives).toHaveLength(1);
});

it("cancels an already queued handoff before any provider is selected", async () => {
  const review = await parseHandoffReview(JSON.stringify(envelope()));
  const pending = controller.confirmHandoff(review);
  const cancel = controller.cancelHandoff(review);
  expect(controller.cancelHandoff(review)).toBe(cancel);
  expect(await pending).toMatchObject({ status: "rejected" });
  expect(await cancel).toBe(true); expect(natives).toEqual([]);
});

it.each(["normal", "small"] as const)("Escape during delayed handoff start cancels before input on a %s terminal", async (size) => {
  controller.select("claude");
  const native = natives[0]; const start = native.start.bind(native); const send = vi.spyOn(native, "sendInput"); const dispose = vi.spyOn(native, "dispose");
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const starting = vi.spyOn(native, "start").mockImplementation(async (command) => { const result = await start(command); await gate; return result; });
  const { view, back, opened } = await reviewScreen();
  let pages = 0; while (!view.lastFrame()!.includes("y Confirm once") && pages++ < 10) await press(view, "\u001b[6~");
  view.stdin.write("y"); await vi.waitFor(() => expect(starting).toHaveBeenCalledOnce());
  if (size === "small") {
    Object.defineProperty(view.stdout, "rows", { value: 12, configurable: true }); Object.defineProperty(view.stdout, "columns", { value: 48, configurable: true }); view.stdout.emit("resize"); await tick();
  }
  view.stdin.write("\u001b"); view.stdin.write("\u001b");
  await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
  expect(back).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  release(); await vi.waitFor(() => expect(back).toHaveBeenCalledOnce());
  expect(opened).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(controller.canBeginHandoff()).toBe(true);
  expect(await controller.manager.store.list()).toEqual([]);
});

it("opens a fresh workspace after closing and reselecting the same provider", async () => {
  const view = render(<ManagedNativeWorkspace controller={controller} workspace={workspace} back={() => {}} />); await tick();
  await press(view, "\r"); await press(view, "\r"); await press(view, "\r");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Ready"));
  const oldIdentity = controller.selectedService!.getSnapshot().identity;
  const start = vi.spyOn(natives[0], "start");
  await press(view, "x"); await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Closed"));
  await press(view, "n"); await press(view, "\r");
  expect(view.lastFrame()).toContain("Codex workspace directory"); expect(start).not.toHaveBeenCalled();
  await press(view, "\r"); await press(view, "\r");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Ready"));
  expect(start).toHaveBeenCalledOnce(); expect(controller.selectedService!.getSnapshot().identity?.sessionId).not.toBe(oldIdentity?.sessionId);
});

it("keeps failed cleanup reachable rather than offering a fresh workspace", async () => {
  const view = render(<ManagedNativeWorkspace controller={controller} workspace={workspace} back={() => {}} />); await tick();
  await press(view, "\r"); await press(view, "\r"); await press(view, "\r");
  await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Ready"));
  const native = natives[0]; const dispose = native.dispose.bind(native);
  vi.spyOn(native, "dispose").mockResolvedValueOnce({ status: "error", code: "cleanup_failed", message: "Synthetic unconfirmed cleanup" }).mockImplementation(dispose);
  const start = vi.spyOn(native, "start");
  await press(view, "x"); await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Error"));
  await press(view, "n"); await press(view, "\r");
  expect(view.lastFrame()).toContain("Codex · Error"); expect(view.lastFrame()).not.toContain("workspace directory"); expect(start).not.toHaveBeenCalled();
  await press(view, "x"); await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Closed"));
  await press(view, "n"); await press(view, "\r"); expect(view.lastFrame()).toContain("Codex workspace directory");
});


it("does not let cancellation of an old review close a newer session on the same service", async () => {
  const review = await parseHandoffReview(JSON.stringify(envelope()));
  expect(await controller.confirmHandoff(review)).toMatchObject({ status: "ok" });
  const service = controller.selectedService!;
  const oldIdentity = service.getSnapshot().identity;
  await service.close(); await service.start(workspace);
  const newIdentity = service.getSnapshot().identity;
  expect(newIdentity?.sessionId).not.toBe(oldIdentity?.sessionId);
  const dispose = vi.spyOn(natives[0], "dispose");
  expect(await controller.cancelHandoff(review)).toBe(true);
  expect(dispose).not.toHaveBeenCalled();
  expect(service.getSnapshot()).toMatchObject({ phase: "ready", identity: newIdentity });
  expect(await service.sendInput("New session's explicit input")).toMatchObject({ status: "ok" });
});

it("retains the handoff's cleanup ownership when native close is unconfirmed", async () => {
  const review = await parseHandoffReview(JSON.stringify(envelope()));
  expect(await controller.confirmHandoff(review)).toMatchObject({ status: "ok" });
  const native = natives[0]; const dispose = native.dispose.bind(native);
  vi.spyOn(native, "dispose").mockResolvedValueOnce({ status: "error", code: "cleanup_failed", message: "Synthetic unconfirmed cleanup" }).mockImplementation(dispose);
  expect(await controller.cancelHandoff(review)).toBe(false);
  expect(controller.selectedService!.getSnapshot().phase).toBe("error");
  expect(controller.canBeginHandoff()).toBe(false);
  await controller.selectedService!.close();
  expect(controller.canBeginHandoff()).toBe(true);
});
