import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeNativeHarnessAdapter } from "../../src/harness/fake.js";
import { NativeSessionManager, type NativeSessionFactoryHooks, type SessionManagerNotice } from "../../src/harness/session-manager.js";
import { NativeSessionStore } from "../../src/harness/session-store.js";
import type { DisposeSessionCommand, NativeHarnessCommandResult, NativeHarnessEvent, NativeHarnessEventListener, NativeHarnessSessionIdentity, ObserveSessionCommand, SendInputCommand, StartSessionCommand } from "../../src/harness/types.js";

class DeferredNative extends FakeNativeHarnessAdapter {
  actual?: NativeHarnessSessionIdentity;
  bound = false;
  constructor(readonly hooks: NativeSessionFactoryHooks) { super({ adapterId: "claude", turnIdentity: "local", nativeSessionId: (id) => `confirmed-${id}` }); }
  override async start(command: StartSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    const result = await super.start(command);
    if (result.status !== "ok") return result;
    this.actual = result.value; this.bound = false;
    return { status: "ok", value: { adapterId: this.adapterId, sessionId: command.sessionId } };
  }
  async confirm() { await this.hooks.onNativeSessionConfirmed(this.actual!); this.bound = true; }
  override observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener) {
    return super.observe({ ...command, session: this.actual! }, (event) => listener({ ...event, nativeSessionId: this.bound ? event.nativeSessionId : undefined }));
  }
  override sendInput(command: SendInputCommand) { return super.sendInput({ ...command, session: this.actual! }); }
  override dispose(command: DisposeSessionCommand) { return super.dispose({ ...command, session: this.actual ?? command.session }); }
}

let root: string;
let workspace: string;
let store: NativeSessionStore;
let manager: NativeSessionManager;
let native: DeferredNative;
let hooks: NativeSessionFactoryHooks;
const disposals: Array<() => Promise<unknown>> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-native-confirmation-")); workspace = join(root, "workspace"); await mkdir(workspace);
  store = new NativeSessionStore({ directory: join(root, "state") });
  manager = new NativeSessionManager({ store, adapters: { claude: (_store, factoryHooks) => {
    hooks = factoryHooks; native = new DeferredNative(hooks); return native;
  } } });
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(disposals.splice(0).map((close) => close())); await rm(root, { recursive: true, force: true }); });
async function open(onNotice?: (notice: SessionManagerNotice) => void) {
  const adapter = manager.createAdapter("claude", { onNotice });
  const result = await adapter.start({ type: "session.start", sessionId: "local", workspace });
  expect(result.status).toBe("ok"); if (result.status !== "ok") throw new Error("Synthetic start failed");
  disposals.push(() => adapter.dispose({ type: "session.dispose", session: result.value }));
  return { adapter, session: result.value };
}

describe("delayed native identity confirmation", () => {
  it("keeps input ready without a guessed registration, then adopts and registers the confirmed identity once", async () => {
    const notices: SessionManagerNotice[] = [];
    const { adapter, session } = await open((value) => notices.push(value));
    expect(session.nativeSessionId).toBeUndefined(); expect(await store.list()).toEqual([]);
    expect(notices).toEqual([expect.objectContaining({ code: "native_identity_pending" })]);
    expect(await adapter.sendInput({ type: "session.input", session, input: "First explicit input" })).toMatchObject({ status: "ok" });
    const remember = vi.spyOn(store, "rememberCreatedSession");
    const first = hooks.onNativeSessionConfirmed(native.actual!);
    const duplicate = hooks.onNativeSessionConfirmed({ ...native.actual! });
    expect(duplicate).toBe(first);
    await first; await duplicate; await hooks.onNativeSessionConfirmed(native.actual!);
    native.bound = true;
    expect(remember).toHaveBeenCalledTimes(1);
    expect(notices.at(-1)).toMatchObject({ code: "native_registration_ready" });
    expect(await store.list()).toEqual([expect.objectContaining(native.actual!)]);
    expect(await store.inspectOwnership({ adapterId: "claude", nativeSessionId: native.actual!.nativeSessionId! })).toBe("active");
    expect(adapter.observe({ type: "session.observe", session: native.actual! }, () => {})).toMatchObject({ status: "ok" });
    expect(await adapter.sendInput({ type: "session.input", session, input: "stale identity" })).toMatchObject({ status: "rejected" });
    await adapter.dispose({ type: "session.dispose", session: native.actual! });
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects confirmation before successful start, wrong local/provider identity, and rebinding", async () => {
    manager.createAdapter("claude");
    await expect(hooks.onNativeSessionConfirmed({ adapterId: "claude", sessionId: "missing", nativeSessionId: "native" })).rejects.toMatchObject({ code: "invalid_identity" });
    const { adapter } = await open();
    for (const identity of [{ ...native.actual!, adapterId: "codex" }, { ...native.actual!, sessionId: "old-incarnation" }, { ...native.actual!, nativeSessionId: undefined }]) {
      await expect(hooks.onNativeSessionConfirmed(identity)).rejects.toMatchObject({ code: "invalid_identity" });
    }
    expect(await store.list()).toEqual([]);
    await native.confirm();
    await expect(hooks.onNativeSessionConfirmed({ ...native.actual!, nativeSessionId: "replacement" })).rejects.toMatchObject({ code: "identity_mismatch" });
    expect((await store.list())[0].nativeSessionId).toBe(native.actual!.nativeSessionId);
    await adapter.dispose({ type: "session.dispose", session: native.actual! });
    await expect(hooks.onNativeSessionConfirmed(native.actual!)).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("snapshots confirmed identity before waiting on storage", async () => {
    await open();
    const identity = { ...native.actual! };
    const pending = hooks.onNativeSessionConfirmed(identity);
    identity.nativeSessionId = "mutated-after-call";
    await pending;
    expect((await store.list())[0].nativeSessionId).toBe("confirmed-local");
  });

  it("keeps a confirmed session usable if optional registration fails", async () => {
    const notices: SessionManagerNotice[] = [];
    const { adapter } = await open((value) => notices.push(value));
    await store.list(); await writeFile(store.statePath, "synthetic-corrupt-state", { mode: 0o600 });
    await native.confirm();
    expect(notices.at(-1)).toMatchObject({ code: "corrupt_state", message: expect.stringContaining("usable") });
    expect(await adapter.sendInput({ type: "session.input", session: native.actual!, input: "Explicit input" })).toMatchObject({ status: "ok" });
    expect(await readFile(store.statePath, "utf8")).toBe("synthetic-corrupt-state");
  });

  it("rejects changed workspaces and closes the owned connection without registration", async () => {
    const { adapter, session } = await open();
    await rename(workspace, join(root, "original-workspace")); await mkdir(workspace);
    await expect(native.confirm()).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(await store.list()).toEqual([]);
    expect(await adapter.sendInput({ type: "session.input", session, input: "must reject" })).toMatchObject({ status: "rejected" });
  });

  it("cancels confirmation after registration commits, removes that registration, and releases ownership after cleanup", async () => {
    const { adapter, session } = await open();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const remember = store.rememberCreatedSession.bind(store);
    vi.spyOn(store, "rememberCreatedSession").mockImplementation(async (...args) => { const record = await remember(...args); await gate; return record; });
    const confirmation = native.confirm();
    await vi.waitFor(async () => expect(await store.list()).toHaveLength(1));
    const closing = adapter.dispose({ type: "session.dispose", session });
    release();
    await expect(confirmation).rejects.toMatchObject({ code: "aborted" });
    expect(await closing).toMatchObject({ status: "ok" });
    expect(await store.list()).toEqual([]);
    expect(await store.inspectOwnership({ adapterId: "claude", nativeSessionId: "confirmed-local" })).toBe("available");
  });

  it("does not accept an event that upgrades identity without the confirmation hook", async () => {
    const { adapter, session } = await open();
    const events: unknown[] = [];
    const secondEvents: unknown[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => { events.push(event); throw new Error("Synthetic renderer failure"); });
    adapter.observe({ type: "session.observe", session }, (event) => secondEvents.push(event));
    native.bound = true; // Deliberately violate the native adapter's confirmation boundary.
    native.emit(native.actual!, { type: "session.state", state: "ready" });
    expect(events).toEqual([expect.objectContaining({ type: "session.error", nativeSessionId: undefined, error: expect.objectContaining({ code: "identity_mismatch" }) })]);
    expect(secondEvents).toEqual(events);
    expect(await store.list()).toEqual([]);
    await expect(hooks.onNativeSessionConfirmed(native.actual!)).rejects.toMatchObject({ code: "invalid_identity" });
  });

  it("aborts confirmation when a native terminal event arrives after registration commits", async () => {
    const { adapter, session } = await open();
    const events: NativeHarnessEvent[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const remember = store.rememberCreatedSession.bind(store);
    vi.spyOn(store, "rememberCreatedSession").mockImplementation(async (...args) => {
      const saved = await remember(...args); await gate; return saved;
    });
    const confirmation = native.confirm();
    await vi.waitFor(async () => expect(await store.list()).toHaveLength(1));
    native.emit(native.actual!, { type: "session.error", error: { code: "synthetic_disconnect", message: "Synthetic disconnect", retryable: false } });
    release();
    await expect(confirmation).rejects.toMatchObject({ code: "aborted" });
    expect(native.bound).toBe(false);
    expect(await adapter.dispose({ type: "session.dispose", session })).toMatchObject({ status: "ok" });
    expect(await store.list()).toEqual([]);
    expect(events.filter((event) => event.type === "session.error")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: "synthetic_disconnect" }) }),
    ]);
    expect(await store.inspectOwnership({ adapterId: "claude", nativeSessionId: "confirmed-local" })).toBe("available");
  });

  it("reports failed confirmation once to all existing observers after accepted input", async () => {
    const { adapter, session } = await open();
    const first: NativeHarnessEvent[] = []; const second: NativeHarnessEvent[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => first.push(event));
    adapter.observe({ type: "session.observe", session }, (event) => second.push(event));
    expect(await adapter.sendInput({ type: "session.input", session, input: "One explicit input" })).toMatchObject({ status: "ok" });
    const other = await store.acquireOwnership({ adapterId: "claude", nativeSessionId: "confirmed-local" });
    try {
      await expect(native.confirm()).rejects.toMatchObject({ code: "session_busy" });
      native.emit(native.actual!, { type: "session.error", error: { code: "adapter_confirmation_failed", message: "Synthetic rejected hook", retryable: false } });
      for (const events of [first, second]) {
        expect(events.filter((event) => event.type === "session.error")).toEqual([
          expect.objectContaining({ nativeSessionId: undefined, error: expect.objectContaining({ code: "session_busy" }) }),
        ]);
        expect(events.at(-1)!.sequence).toBeGreaterThan(events.at(-2)!.sequence);
      }
      expect(first).toEqual(second);
      expect(await adapter.dispose({ type: "session.dispose", session })).toMatchObject({ status: "ok" });
      expect(await store.list()).toEqual([]);
    } finally { await other.release(); }
  });

  it("does not confirm after a terminal native event", async () => {
    const { adapter, session } = await open();
    adapter.observe({ type: "session.observe", session }, () => {});
    native.emit(native.actual!, { type: "session.error", error: { code: "synthetic", message: "Synthetic disconnect", retryable: false } });
    await expect(native.confirm()).rejects.toMatchObject({ code: "invalid_identity" });
    expect(await store.list()).toEqual([]);
  });
});


it("rejects a failed confirmation without waiting on a reader that is awaiting that hook", async () => {
  const { adapter, session } = await open();
  const other = await store.acquireOwnership({ adapterId: "claude", nativeSessionId: "confirmed-local" });
  let readerFinished!: () => void;
  const reader = new Promise<void>((resolve) => { readerFinished = resolve; });
  const dispose = native.dispose.bind(native);
  vi.spyOn(native, "dispose").mockImplementation(async (command) => { await reader; return dispose(command); });
  let published = false;
  const reading = (async () => {
    try { await native.confirm(); published = true; }
    finally { readerFinished(); }
  })();
  await expect(reading).rejects.toMatchObject({ code: "session_busy" });
  expect(published).toBe(false);
  expect(await adapter.dispose({ type: "session.dispose", session })).toMatchObject({ status: "ok" });
  expect(await store.list()).toEqual([]);
  await other.release();
}, 1500);

it("cancels while the native reader awaits confirmation without a hook/disposal cycle", async () => {
  const { adapter, session } = await open();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const remember = store.rememberCreatedSession.bind(store);
  const saving = vi.spyOn(store, "rememberCreatedSession").mockImplementation(async (...args) => {
    const saved = await remember(...args); await gate; return saved;
  });
  let readerFinished!: () => void;
  const reader = new Promise<void>((resolve) => { readerFinished = resolve; });
  const dispose = native.dispose.bind(native);
  vi.spyOn(native, "dispose").mockImplementation(async (command) => { await reader; return dispose(command); });
  let published = false;
  const reading = (async () => { try { await native.confirm(); published = true; } finally { readerFinished(); } })();
  await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce());
  const closing = adapter.dispose({ type: "session.dispose", session });
  release();
  await expect(reading).rejects.toMatchObject({ code: "aborted" });
  expect(await closing).toMatchObject({ status: "ok" });
  expect(published).toBe(false);
  expect(await store.list()).toEqual([]);
  expect(await store.inspectOwnership({ adapterId: "claude", nativeSessionId: "confirmed-local" })).toBe("available");
}, 1500);


it("rejects confirmation when its success notice synchronously closes the connection", async () => {
  let closeOnReady: (() => void) | undefined;
  const { adapter, session } = await open((value) => { if (value.code === "native_registration_ready") closeOnReady?.(); });
  let closing: ReturnType<typeof adapter.dispose> | undefined;
  closeOnReady = () => { closing = adapter.dispose({ type: "session.dispose", session }); };
  let readerFinished!: () => void;
  const reader = new Promise<void>((resolve) => { readerFinished = resolve; });
  const dispose = native.dispose.bind(native);
  vi.spyOn(native, "dispose").mockImplementation(async (command) => { await reader; return dispose(command); });
  const reading = (async () => { try { await native.confirm(); } finally { readerFinished(); } })();
  await expect(reading).rejects.toMatchObject({ code: "aborted" });
  expect(native.bound).toBe(false);
  expect(closing).toBeDefined();
  expect(await closing).toMatchObject({ status: "ok" });
  expect(await store.list()).toEqual([]);
  expect(await store.inspectOwnership({ adapterId: "claude", nativeSessionId: "confirmed-local" })).toBe("available");
}, 1500);
