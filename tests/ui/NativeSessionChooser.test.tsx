import React from "react";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render, cleanup } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNativeHarnessAdapter } from "../../src/harness/fake.js";
import { NativeSessionStore, SessionStoreError } from "../../src/harness/session-store.js";
import { NativeSessionManager } from "../../src/harness/session-manager.js";
import { NativeSessionChooser } from "../../src/ui/NativeSessionChooser.js";
import { NativeSessionService } from "../../src/ui/native-session-service.js";
import { createNativeSessionsPanel } from "../../src/ui/NativeSessionsPanel.js";

let directory: string, workspace: string, store: NativeSessionStore, manager: NativeSessionManager, native: FakeNativeHarnessAdapter;
const services: NativeSessionService[] = []; const closers: Array<() => Promise<unknown>> = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function press(view: ReturnType<typeof render>, key: string) { view.stdin.write(key); await tick(); }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ace-native-chooser-")); workspace = join(directory, "workspace"); await mkdir(workspace);
  store = new NativeSessionStore({ directory: join(directory, "state"), lockTimeoutMs: 50 });
  native = new FakeNativeHarnessAdapter({ adapterId: "codex", capabilities: { resume: { supported: true } } });
  manager = new NativeSessionManager({ store, adapters: { codex: () => native } });
});
afterEach(async () => { cleanup(); await Promise.all(services.splice(0).map((service) => service.dispose())); await Promise.all(closers.splice(0).map((close) => close())); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function seed(close = true) {
  const adapter = manager.createAdapter("codex"); const result = await adapter.start({ type: "session.start", sessionId: "original", workspace });
  if (result.status !== "ok") throw new Error("Synthetic seed failed");
  const dispose = () => adapter.dispose({ type: "session.dispose", session: result.value }); closers.push(dispose);
  if (close) await dispose();
  return (await store.list())[0];
}
function chooser() {
  const service = new NativeSessionService(manager.createAdapter("codex")); services.push(service);
  const start = vi.fn(); const resume = vi.fn(); const back = vi.fn();
  const view = render(<NativeSessionChooser manager={manager} adapterId="codex" workspace={workspace} start={start} resume={resume} back={back} runLocalOperation={service.runLocalOperation} />);
  return { view, start, resume, back, service };
}
async function loaded(view: ReturnType<typeof render>) { await vi.waitFor(() => { expect(view.lastFrame()).toContain("Saved native sessions"); expect(view.lastFrame()).not.toContain("Reading local registrations"); }); }
async function saved(view: ReturnType<typeof render>) { await tick(); await press(view, "\u001b[B"); await press(view, "\r"); await loaded(view); }

describe("explicit native session chooser", () => {
  it("lists local candidates without native inspection and requires Enter before resume", async () => {
    const record = await seed(); const calls = vi.spyOn(native, "resume"); const inputs = vi.spyOn(native, "sendInput"); const starts = vi.spyOn(native, "start");
    const { view, resume } = chooser(); await saved(view);
    expect(view.lastFrame()).toContain("native-original"); expect(view.lastFrame()).toContain("Available");
    expect(resume).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled(); expect(starts).not.toHaveBeenCalled(); expect(inputs).not.toHaveBeenCalled();
    await press(view, "\r"); expect(resume).toHaveBeenCalledWith(record);
  });

  it("shows active ownership as unavailable and blocks resume/forget", async () => {
    await seed(false); const forget = vi.spyOn(manager, "forget"); const { view, resume } = chooser(); await saved(view);
    expect(view.lastFrame()).toContain("Unavailable"); expect(view.lastFrame()).toContain("Another Ace connection owns");
    await press(view, "\r"); await press(view, "f"); await press(view, "y");
    expect(resume).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled();
  });

  it("requires separate confirmation before forgetting only the selected local registration", async () => {
    await seed(); const forget = vi.spyOn(manager, "forget"); const { view } = chooser(); await saved(view);
    await press(view, "f"); expect(view.lastFrame()).toContain("Forget this local registration?");
    await press(view, "\r"); expect(forget).not.toHaveBeenCalled();
    await press(view, "n"); expect(await store.list()).toHaveLength(1);
    await press(view, "f"); await press(view, "y"); await loaded(view);
    expect(forget).toHaveBeenCalledWith({ adapterId: "codex", sessionId: "original" });
    expect(await store.list()).toEqual([]); expect(view.lastFrame()).toContain("Native history was not deleted");
  });

  it("keeps corrupt bytes until explicit recovery and reports the private backup", async () => {
    await store.list(); await writeFile(store.statePath, "synthetic-corrupt", { mode: 0o600 });
    const recover = vi.spyOn(manager, "quarantineCorruptState"); const { view } = chooser(); await saved(view);
    expect(view.lastFrame()).toContain("c Recover corrupt state"); expect(recover).not.toHaveBeenCalled();
    await press(view, "c"); await press(view, "\r"); expect(recover).not.toHaveBeenCalled();
    expect(await readFile(store.statePath, "utf8")).toBe("synthetic-corrupt");
    await press(view, "y"); await loaded(view); expect(recover).toHaveBeenCalledOnce(); expect(await store.list()).toEqual([]);
    const backup = (await readdir(store.directory)).find((name) => name.startsWith("native-sessions.corrupt-"))!;
    expect(await readFile(join(store.directory, backup), "utf8")).toBe("synthetic-corrupt");
    expect(view.lastFrame()).toContain("Private backup:");
  });

  it("disables invisible resume and recovery controls at48×12", async () => {
    await seed(); const { view, resume } = chooser(); await saved(view);
    Object.defineProperty(view.stdout, "columns", { value: 48, configurable: true }); Object.defineProperty(view.stdout, "rows", { value: 12, configurable: true }); view.stdout.emit("resize"); await tick();
    await press(view, "\r"); await press(view, "f"); await press(view, "y");
    expect(resume).not.toHaveBeenCalled(); expect(view.lastFrame()).toContain("Actions paused"); expect(await store.list()).toHaveLength(1);
  });

  it("resumes through the managed panel with fresh local identity and no replay", async () => {
    const record = await seed(); const resume = vi.spyOn(native, "resume"); const inputs = vi.spyOn(native, "sendInput"); const approvals = vi.spyOn(native, "respondToApproval");
    const panel = createNativeSessionsPanel({ manager, workspace }); closers.push(() => panel.dispose!());
    const view = render(<>{panel.render({ back: vi.fn(), sanitize: (value) => value })}</>); await tick();
    await press(view, "\r"); await press(view, "\r"); expect(view.lastFrame()).toContain("Open a native session");
    await press(view, "\u001b[B"); await press(view, "\r"); await loaded(view); expect(resume).not.toHaveBeenCalled();
    await press(view, "\r"); await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Ready")); expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0][0]).toMatchObject({ registeredSessionId: record.sessionId, nativeSessionId: record.nativeSessionId, workspace });
    expect(resume.mock.calls[0][0].sessionId).not.toBe(record.sessionId);
    expect(view.lastFrame()).toContain("Earlier conversation is not loaded"); expect(inputs).not.toHaveBeenCalled(); expect(approvals).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects a registration removed after selection without native resume or fallback start", async () => {
    const record = await seed(); const resume = vi.spyOn(native, "resume"); const start = vi.spyOn(native, "start");
    const service = new NativeSessionService(manager.createAdapter("codex")); services.push(service);
    await manager.forget(record);
    expect(await service.resume(record, workspace)).toMatchObject({ status: "error", code: "record_not_found" });
    expect(resume).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(service.getSnapshot().phase).toBe("error");
  });

  it("preserves usable-session registration warnings and never repeats start", async () => {
    await store.list(); await writeFile(store.statePath, "synthetic-corrupt", { mode: 0o600 });
    const calls = vi.spyOn(native, "start"); const panel = createNativeSessionsPanel({ manager, workspace }); closers.push(() => panel.dispose!());
    const view = render(<>{panel.render({ back: vi.fn(), sanitize: (value) => value })}</>); await tick();
    await press(view, "\r"); await press(view, "\r"); await press(view, "\r");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("Codex · Ready"));
    expect(calls).toHaveBeenCalledOnce(); expect(view.lastFrame()).toContain("Codex · Ready"); expect(view.lastFrame()).toContain("Registration:");
    await press(view, "\u001b[C"); expect(view.lastFrame()).toContain("Local registration");
    expect(await readFile(store.statePath, "utf8")).toBe("synthetic-corrupt");
  });


  it("makes a long manual recovery path inspectable in the paginated details view", async () => {
    const recoveryPath = `/synthetic/${"long-directory/".repeat(100)}inspect-this-stale-lock.json`;
    vi.spyOn(manager, "listCandidates").mockRejectedValue(new SessionStoreError("stale_lock", "Inspect the old lock before retrying.", recoveryPath));
    const { view } = chooser(); await saved(view); await press(view, "d");
    expect(view.lastFrame()).toContain("Saved-session details");
    for (let i = 0; i < 5; i++) await press(view, "\u001b[6~");
    expect(view.lastFrame()).toContain("inspect-this-stale-lock.json");
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(19);
  });

  it("awaits confirmed local storage work during disposal and rejects later mutations", async () => {
    const { service } = chooser(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = service.runLocalOperation(() => gate); await Promise.resolve();
    let closed = false; const close = service.dispose().then(() => { closed = true; }); await tick(); expect(closed).toBe(false);
    release(); await operation; await close; expect(closed).toBe(true);
    const mutation = vi.fn(async () => undefined);
    await expect(service.runLocalOperation(mutation)).rejects.toThrow("closing"); expect(mutation).not.toHaveBeenCalled();
  });
});
