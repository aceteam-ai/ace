import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeNativeHarnessAdapter } from "../../src/harness/fake.js";
import { ClaudeNativeHarnessAdapter } from "../../src/harness/claude.js";
import { NativeSessionStore } from "../../src/harness/session-store.js";
import { NativeSessionManager, type SessionManagerNotice } from "../../src/harness/session-manager.js";
import type { NativeHarnessSessionIdentity } from "../../src/harness/types.js";
import { SyntheticClaudeSdk } from "./fixtures/claude-sdk.js";

let root: string;
let workspace: string;
let store: NativeSessionStore;
let native: FakeNativeHarnessAdapter;
let manager: NativeSessionManager;
const disposals: Array<() => Promise<unknown>> = [];
const start = (sessionId = "original") => ({ type: "session.start" as const, sessionId, workspace });
const resume = (identity: NativeHarnessSessionIdentity, sessionId = "new-incarnation") => ({
  type: "session.resume" as const, registeredSessionId: identity.sessionId, sessionId,
  nativeSessionId: identity.nativeSessionId!, workspace,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-session-manager-"));
  workspace = join(root, "workspace"); await mkdir(workspace);
  store = new NativeSessionStore({ directory: join(root, "state"), lockTimeoutMs: 100 });
  native = new FakeNativeHarnessAdapter({ adapterId: "codex", capabilities: { resume: { supported: true } } });
  manager = new NativeSessionManager({ store, adapters: { codex: () => native } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
  await rm(root, { recursive: true, force: true });
});
async function opened(adapter = manager.createAdapter("codex")) {
  const result = await adapter.start(start());
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Synthetic opening failed");
  disposals.push(() => adapter.dispose({ type: "session.dispose", session: result.value }));
  return { adapter, session: result.value };
}

describe("managed native session lifecycle", () => {
  it("registers only a successful new native session and does not submit a turn", async () => {
    const starts = vi.spyOn(native, "start");
    const inputs = vi.spyOn(native, "sendInput");
    const { adapter, session } = await opened();
    expect(starts).toHaveBeenCalledTimes(1);
    expect(inputs).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([expect.objectContaining(session)]);
    expect(await store.inspectOwnership({ adapterId: "codex", nativeSessionId: session.nativeSessionId! })).toBe("active");
    expect((await manager.listCandidates(workspace))[0]).toMatchObject({ eligible: false, ownership: "active" });
    await adapter.dispose({ type: "session.dispose", session });
    expect((await manager.listCandidates(workspace))[0]).toMatchObject({ eligible: true, ownership: "available" });
  });

  it("resumes only after explicit selection in a new manager with a fresh local identity", async () => {
    const { adapter, session } = await opened();
    await adapter.dispose({ type: "session.dispose", session });
    const resumed = vi.spyOn(native, "resume"); const inputs = vi.spyOn(native, "sendInput");
    const restarted = new NativeSessionManager({ store: new NativeSessionStore({ directory: store.directory }), adapters: { codex: () => native } });
    expect((await restarted.listCandidates(workspace))[0].eligible).toBe(true);
    expect(resumed).not.toHaveBeenCalled(); expect(inputs).not.toHaveBeenCalled();
    const current = restarted.createAdapter("codex");
    const result = await current.resume(resume(session));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("resume failed");
    disposals.push(() => current.dispose({ type: "session.dispose", session: result.value }));
    expect(result.value.sessionId).not.toBe(session.sessionId);
    expect(result.value.nativeSessionId).toBe(session.nativeSessionId);
    expect(resumed).toHaveBeenCalledTimes(1); expect(inputs).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
    expect(await current.sendInput({ type: "session.input", session, input: "old command" })).toMatchObject({ status: "rejected" });
    expect(await current.respondToApproval({ type: "approval.respond", session: result.value, approvalId: "old-approval", decision: "allow" })).toMatchObject({ status: "rejected" });
    expect(await current.sendInput({ type: "session.input", session: result.value, input: "new explicit input" })).toMatchObject({ status: "ok" });
    expect(await readFile(store.statePath, "utf8")).not.toContain("new explicit input");
  });

  it("keeps a new native session usable when registration is corrupt, without repeating start", async () => {
    await store.list(); await writeFile(store.statePath, "synthetic-corrupt-state", { mode: 0o600 });
    const notices: SessionManagerNotice[] = [];
    const adapter = manager.createAdapter("codex", { onNotice: (problem) => notices.push(problem) });
    const starts = vi.spyOn(native, "start");
    const { session } = await opened(adapter);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([expect.objectContaining({ code: "corrupt_state", message: expect.stringContaining("usable") })]);
    expect(await adapter.sendInput({ type: "session.input", session, input: "Synthetic prompt" })).toMatchObject({ status: "ok" });
    expect(await readFile(store.statePath, "utf8")).toBe("synthetic-corrupt-state");
    await adapter.dispose({ type: "session.dispose", session });
    await expect(manager.listCandidates(workspace)).rejects.toMatchObject({ code: "corrupt_state" });
    const backup = await manager.quarantineCorruptState();
    expect(await readFile(backup.backupPath, "utf8")).toBe("synthetic-corrupt-state");
    expect(await manager.listCandidates(workspace)).toEqual([]);
  });

  it("does not register failed starts or call resume for wrong workspace/provider/native identity", async () => {
    const starts = vi.spyOn(native, "start").mockResolvedValueOnce({ status: "error", code: "synthetic_failure", message: "Synthetic start failed" });
    const adapter = manager.createAdapter("codex");
    expect((await adapter.start(start())).status).toBe("error");
    expect(await store.list()).toEqual([]);
    const { session } = await opened(adapter);
    await adapter.dispose({ type: "session.dispose", session });
    const calls = vi.spyOn(native, "resume");
    const other = join(root, "other"); await mkdir(other);
    for (const command of [{ ...resume(session), workspace: other }, { ...resume(session), nativeSessionId: "wrong" }, { ...resume(session), registeredSessionId: "missing" }]) {
      expect((await adapter.resume(command)).status).not.toBe("ok");
    }
    expect(calls).not.toHaveBeenCalled();
    expect(starts).toHaveBeenCalledTimes(2);
    await store.rememberCreatedSession({ adapterId: "other", sessionId: "foreign", nativeSessionId: "foreign-native" }, workspace);
    expect((await manager.listCandidates(workspace)).find((entry) => entry.record.adapterId === "other")).toMatchObject({ eligible: false });
    expect((await manager.listCandidates(other)).every((entry) => !entry.eligible)).toBe(true);
  });

  it("rejects active ownership before resume or forgetting, and never closes the current owner", async () => {
    const { session } = await opened();
    const calls = vi.spyOn(native, "resume");
    const other = manager.createAdapter("codex");
    expect(await other.resume(resume(session))).toMatchObject({ status: "error", code: "session_busy" });
    expect(calls).not.toHaveBeenCalled();
    await expect(manager.forget(session)).rejects.toMatchObject({ code: "session_busy" });
    expect(await store.inspectOwnership({ adapterId: "codex", nativeSessionId: session.nativeSessionId! })).toBe("active");
  });

  it("holds ownership until native disposal completes, including simultaneous disposal calls", async () => {
    const { adapter, session } = await opened();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = native.dispose.bind(native);
    const cleanup = vi.spyOn(native, "dispose").mockImplementation(async (command) => { await gate; return original(command); });
    const first = adapter.dispose({ type: "session.dispose", session });
    const second = adapter.dispose({ type: "session.dispose", session });
    expect(await store.inspectOwnership({ adapterId: "codex", nativeSessionId: session.nativeSessionId! })).toBe("active");
    release();
    expect(await first).toMatchObject({ status: "ok" }); expect(await second).toMatchObject({ status: "ok" });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await store.inspectOwnership({ adapterId: "codex", nativeSessionId: session.nativeSessionId! })).toBe("available");
  });

  it("cancels a pending start and cleans the eventual native identity without registration", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = native.start.bind(native);
    const starts = vi.spyOn(native, "start").mockImplementation(async (command) => { await gate; return original(command); });
    const adapter = manager.createAdapter("codex");
    const pending = adapter.start(start());
    await vi.waitFor(() => expect(starts).toHaveBeenCalledOnce());
    expect(await adapter.start(start("second"))).toMatchObject({ status: "rejected" });
    const closing = adapter.dispose({ type: "session.dispose", session: { adapterId: "codex", sessionId: "original" } });
    release();
    expect(await pending).toMatchObject({ status: "error", code: "aborted" });
    expect(await closing).toMatchObject({ status: "ok" });
    expect(await store.list()).toEqual([]);
  });

  it("recovers an abrupt exited owner's lease only on explicit resume and sends no input", async () => {
    const { session } = await opened();
    native.emit(session, { type: "session.error", error: { code: "synthetic_disconnect", message: "Synthetic disconnect", retryable: false } });
    const ownerPath = join(store.directory, (await readdir(store.directory)).find((name) => name.startsWith("native-owner-"))!);
    await writeFile(ownerPath, JSON.stringify({ version: 1, pid: 2147483647, nonce: "exited-owner" }));
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483647) throw Object.assign(new Error("absent"), { code: "ESRCH" });
      return kill(pid, signal);
    });
    expect((await manager.listCandidates(workspace))[0]).toMatchObject({ eligible: true, ownership: "stale" });
    expect(JSON.parse(await readFile(ownerPath, "utf8")).nonce).toBe("exited-owner");
    const current = manager.createAdapter("codex");
    const input = vi.spyOn(native, "sendInput");
    const result = await current.resume(resume(session));
    expect(result.status).toBe("ok"); expect(input).not.toHaveBeenCalled();
    if (result.status === "ok") await current.dispose({ type: "session.dispose", session: result.value });
  });

  it("releases resume ownership when the native history is unavailable", async () => {
    const { adapter, session } = await opened(); await adapter.dispose({ type: "session.dispose", session });
    vi.spyOn(native, "resume").mockResolvedValueOnce({ status: "error", code: "history_missing", message: "Native history is missing" });
    expect(await adapter.resume(resume(session))).toMatchObject({ status: "error", code: "history_missing" });
    expect((await manager.listCandidates(workspace))[0]).toMatchObject({ eligible: true, ownership: "available" });
    expect(await manager.forget(session)).toBe(true);
    expect(await store.list()).toEqual([]);
  });

  it("retains resume ownership when Claude cannot confirm cleanup after a failed open", async () => {
    const saved = { adapterId: "claude", sessionId: "saved-claude", nativeSessionId: "native-claude" };
    await store.rememberCreatedSession(saved, workspace);
    const sdk = new SyntheticClaudeSdk();
    sdk.sessionInfo = { sessionId: saved.nativeSessionId, cwd: workspace };
    let failInitialization!: (error: Error) => void;
    sdk.initialization = new Promise((_resolve, reject) => { failInitialization = reject; });
    sdk.configureQuery = (query) => {
      query.closeError = new Error("synthetic close failure");
      query.returnError = new Error("synthetic return failure");
    };
    const claudeManager = new NativeSessionManager({ store, adapters: { claude: (sessionStore, hooks) =>
      new ClaudeNativeHarnessAdapter({ sessionStore, onNativeSessionConfirmed: hooks.onNativeSessionConfirmed,
        sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" }, cleanupTimeoutMs: 20 }) } });
    const managed = claudeManager.createAdapter("claude");
    const opening = managed.resume({ type: "session.resume", registeredSessionId: saved.sessionId,
      sessionId: "resumed-claude", nativeSessionId: saved.nativeSessionId, workspace });
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(1));
    failInitialization(new Error("synthetic initialization failure"));
    expect(await opening).toMatchObject({ status: "error", code: "native_cleanup_failed" });
    expect(await store.inspectOwnership(saved)).toBe("active");
    expect((await claudeManager.listCandidates(workspace))[0]).toMatchObject({ eligible: false, ownership: "active" });
    expect(await managed.resume({ type: "session.resume", registeredSessionId: saved.sessionId,
      sessionId: "another-connection", nativeSessionId: saved.nativeSessionId, workspace })).toMatchObject({ status: "rejected" });
    expect(sdk.queries[0].closed).toBe(false);

    sdk.queries[0].closeError = undefined;
    sdk.queries[0].returnError = undefined;
    expect(await managed.dispose({ type: "session.dispose", session: { adapterId: "claude", sessionId: "resumed-claude" } })).toMatchObject({ status: "ok" });
    expect(await store.inspectOwnership(saved)).toBe("available");
  });
});


it("removes a registration committed during cancelled opening without repeating a native start", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const remember = store.rememberCreatedSession.bind(store);
  const saved = vi.spyOn(store, "rememberCreatedSession").mockImplementation(async (...args) => {
    const record = await remember(...args); await gate; return record;
  });
  const adapter = manager.createAdapter("codex");
  const pending = adapter.start(start());
  await vi.waitFor(async () => { expect(saved).toHaveBeenCalledOnce(); expect(await store.list()).toHaveLength(1); });
  const closing = adapter.dispose({ type: "session.dispose", session: { adapterId: "codex", sessionId: "original" } });
  release();
  expect(await pending).toMatchObject({ status: "error", code: "aborted" });
  expect(await closing).toMatchObject({ status: "ok" });
  expect(await store.list()).toEqual([]);
});

it("cleans a late native success after an earlier startup disposal was acknowledged", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = native.start.bind(native);
  const starts = vi.spyOn(native, "start").mockImplementation(async (command) => { await gate; return original(command); });
  const cleanup = vi.spyOn(native, "dispose").mockResolvedValueOnce({ status: "ok", value: { disposed: true } });
  const adapter = manager.createAdapter("codex");
  const pending = adapter.start(start());
  await vi.waitFor(() => expect(starts).toHaveBeenCalledOnce());
  const closing = adapter.dispose({ type: "session.dispose", session: { adapterId: "codex", sessionId: "original" } });
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  release();
  expect(await pending).toMatchObject({ status: "error", code: "aborted" });
  expect(await closing).toMatchObject({ status: "ok" });
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(cleanup.mock.calls[1][0].session).toEqual({ adapterId: "codex", sessionId: "original", nativeSessionId: "native-original" });
  expect(await native.sendInput({ type: "session.input", session: { adapterId: "codex", sessionId: "original", nativeSessionId: "native-original" }, input: "must be closed" })).toMatchObject({ status: "rejected" });
  expect(await store.list()).toEqual([]);
});

it("retains ownership after a throwing native cleanup and allows a later explicit close", async () => {
  const { adapter, session } = await opened();
  const cleanup = vi.spyOn(native, "dispose").mockRejectedValueOnce(new Error("synthetic-hidden-cleanup-error"));
  expect(await adapter.dispose({ type: "session.dispose", session })).toMatchObject({ status: "error", code: "native_cleanup_failed" });
  expect(await store.inspectOwnership({ adapterId: "codex", nativeSessionId: session.nativeSessionId! })).toBe("active");
  expect(await adapter.sendInput({ type: "session.input", session, input: "closed view" })).toMatchObject({ status: "rejected" });
  expect(await adapter.dispose({ type: "session.dispose", session })).toMatchObject({ status: "ok" });
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(await store.inspectOwnership({ adapterId: "codex", nativeSessionId: session.nativeSessionId! })).toBe("available");
});

it("cleans the reserved provider/local identity when a native opening reports an unrelated identity", async () => {
  const original = native.start.bind(native);
  vi.spyOn(native, "start").mockImplementation(async (command) => {
    const result = await original(command);
    if (result.status !== "ok") return result;
    return { status: "ok", value: { ...result.value, adapterId: "unrelated", sessionId: "unrelated", nativeSessionId: "unrelated-native" } };
  });
  const dispose = native.dispose.bind(native);
  const cleanup = vi.spyOn(native, "dispose").mockImplementation((command) => {
    if (command.session.nativeSessionId !== undefined) return Promise.resolve({ status: "rejected", code: "invalid_session", message: "Untrusted native ID" });
    return dispose({ ...command, session: { ...command.session, nativeSessionId: "native-original" } });
  });
  const adapter = manager.createAdapter("codex");
  expect(await adapter.start(start())).toMatchObject({ status: "error", code: "identity_mismatch" });
  expect(cleanup).toHaveBeenCalledWith({ type: "session.dispose", session: { adapterId: "codex", sessionId: "original" } });
  expect(await store.list()).toEqual([]);
});

it("keeps failed-opening cleanup reachable when native disposal is unconfirmed", async () => {
  const original = native.start.bind(native);
  vi.spyOn(native, "start").mockImplementation(async (command) => {
    const result = await original(command);
    return result.status === "ok" ? { status: "ok", value: { ...result.value, sessionId: "unrelated" } } : result;
  });
  const dispose = native.dispose.bind(native);
  const cleanup = vi.spyOn(native, "dispose").mockImplementation((command) => dispose({ ...command, session: { ...command.session, nativeSessionId: "native-original" } }))
    .mockResolvedValueOnce({ status: "error", code: "synthetic_cleanup_failed", message: "Not confirmed" });
  const adapter = manager.createAdapter("codex");
  expect(await adapter.start(start())).toMatchObject({ status: "error", code: "native_cleanup_failed" });
  expect(await adapter.start(start("other"))).toMatchObject({ status: "rejected" });
  expect(await adapter.dispose({ type: "session.dispose", session: { adapterId: "codex", sessionId: "original" } })).toMatchObject({ status: "ok" });
  expect(cleanup).toHaveBeenCalledTimes(2);
});
