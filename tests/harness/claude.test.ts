import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeNativeHarnessAdapter, TESTED_CLAUDE_AGENT_SDK_VERSION, TESTED_CLAUDE_CODE_VERSION,
  captureWorkspaceIdentity, type NativeHarnessEvent, type NativeHarnessSessionIdentity,
} from "../../src/harness/index.js";
import { SyntheticClaudeSdk, type SyntheticMessage } from "./fixtures/claude-sdk.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); vi.restoreAllMocks(); });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ace-claude-test-"));
  const directory = join(root, "workspace");
  await mkdir(directory); roots.push(root); return directory;
}

function ids() {
  let value = 0;
  return () => "00000000-0000-4000-8000-" + String(++value).padStart(12, "0");
}

function init(nativeId: string, cwd: string, overrides: Record<string, unknown> = {}): SyntheticMessage {
  return { type: "system", subtype: "init", session_id: nativeId, uuid: "init-event", apiKeySource: "ANTHROPIC_API_KEY",
    claude_code_version: TESTED_CLAUDE_CODE_VERSION, cwd, permissionMode: "default", ...overrides };
}

async function settle() { await new Promise((resolve) => setImmediate(resolve)); }

async function rig(options: { hook?: (identity: NativeHarnessSessionIdentity) => Promise<void>; environment?: Record<string, string | undefined>; reconciliationTimeoutMs?: number; sdk?: SyntheticClaudeSdk } = {}) {
  const cwd = await workspace(); const sdk = options.sdk ?? new SyntheticClaudeSdk(); const hook = options.hook ?? vi.fn(async () => {});
  const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, onNativeSessionConfirmed: hook,
    environment: options.environment ?? { ANTHROPIC_API_KEY: "synthetic-key" }, createId: ids(),
    now: () => "2026-09-10T00:00:00.000Z", cleanupTimeoutMs: 50, initializationTimeoutMs: 50, inputAckTimeoutMs: 100, reconciliationTimeoutMs: options.reconciliationTimeoutMs ?? 50 });
  const opened = await adapter.start({ type: "session.start", sessionId: "ace-local", workspace: cwd });
  expect(opened.status).toBe("ok"); if (opened.status !== "ok") throw new Error(opened.message);
  const session = opened.value; const query = sdk.queries[0]; const events: NativeHarnessEvent[] = [];
  adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
  return { adapter, sdk, hook, cwd, session, query, events };
}

async function startTurn(instance: Awaited<ReturnType<typeof rig>>, prompt = "Synthetic prompt") {
  const sending = instance.adapter.sendInput({ type: "session.input", session: instance.session, input: prompt });
  const input = await instance.query.takeInput();
  const turnId = String(input.uuid); const nativeId = String(input.session_id);
  instance.query.emit(init(nativeId, instance.cwd));
  await vi.waitFor(() => expect(instance.hook).toHaveBeenCalled());
  instance.query.emit(echo(turnId, nativeId));
  expect(await sending).toMatchObject({ status: "ok" });
  await settle();
  return { input, turnId, nativeId };
}

function echo(turnId: string, nativeId: string): SyntheticMessage {
  return { type: "stream_event", session_id: nativeId, uuid: "stream-start-" + turnId, parent_tool_use_id: null,
    user_message_uuid: turnId, user_message_uuids: [turnId], event: { type: "message_start", message: { id: "api-" + turnId } } };
}

function streamDelta(turnId: string, nativeId: string, value: string, part = 1, index = 0): SyntheticMessage {
  return { type: "stream_event", session_id: nativeId, uuid: "stream-delta-" + turnId + "-" + part, parent_tool_use_id: null,
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text: value } } };
}

function result(turnId: string, nativeId: string, overrides: Record<string, unknown> = {}): SyntheticMessage {
  return { type: "result", subtype: "success", is_error: false, result: "Hello", stop_reason: "end_turn",
    permission_denials: [], session_id: nativeId, uuid: "result-1", user_message_uuid: turnId,
    user_message_uuids: [turnId], ...overrides };
}

function idle(nativeId: string): SyntheticMessage {
  return { type: "system", subtype: "session_state_changed", state: "idle", session_id: nativeId, uuid: "idle-1" };
}

// All messages, account metadata, credentials and tool results below are synthetic fixtures.
describe("Claude Agent native adapter", () => {
  it("pins and lazily opens the reviewed SDK boundary with an empty controlled queue", async () => {
    const factory = vi.fn(async () => new SyntheticClaudeSdk());
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: factory, environment: { ANTHROPIC_API_KEY: "synthetic" } });
    expect(factory).not.toHaveBeenCalled();
    expect(TESTED_CLAUDE_AGENT_SDK_VERSION).toBe("0.3.267");
    expect(TESTED_CLAUDE_CODE_VERSION).toBe("2.1.267");
    const cwd = await workspace();
    const opened = await adapter.start({ type: "session.start", sessionId: "lazy", workspace: cwd, nativeOptions: { model: "synthetic-model" } });
    expect(opened.status).toBe("ok"); expect(factory).toHaveBeenCalledOnce();
    if (opened.status !== "ok") return;
    const sdk = await factory.mock.results[0].value;
    expect(sdk.queryCalls[0].options).toMatchObject({ cwd, settingSources: ["user", "project", "local"], includePartialMessages: true,
      agentProgressSummaries: false, promptSuggestions: false, model: "synthetic-model" });
    expect(sdk.queryCalls[0].options).not.toHaveProperty("allowedTools");
    expect(opened.value.nativeSessionId).toBeUndefined();
    await adapter.dispose({ type: "session.dispose", session: opened.value });
  });

  it.each([
    [{}, "claude_authentication_required"],
    [{ ANTHROPIC_API_KEY: "key", ANTHROPIC_AUTH_TOKEN: "token" }, "claude_authentication_route_unsupported"],
    [{ ANTHROPIC_API_KEY: "key", CLAUDE_CODE_USE_BEDROCK: "true" }, "claude_authentication_route_unsupported"],
  ])("rejects unsupported authentication routes before importing the SDK", async (environment, code) => {
    const factory = vi.fn(async () => new SyntheticClaudeSdk()); const cwd = await workspace();
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: factory, environment });
    const opened = await adapter.start({ type: "session.start", sessionId: "auth", workspace: cwd });
    expect(opened).toMatchObject({ status: "error", code }); expect(factory).not.toHaveBeenCalled();
  });

  it("confirms delayed native identity through the awaited hook before publishing native events", async () => {
    let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
    const hook = vi.fn(async () => barrier); const instance = await rig({ hook });
    const sending = instance.adapter.sendInput({ type: "session.input", session: instance.session, input: "Confirm" });
    const input = await instance.query.takeInput();
    instance.query.emit(init(String(input.session_id), instance.cwd));
    await vi.waitFor(() => expect(hook).toHaveBeenCalled());
    expect(hook).toHaveBeenCalledWith({ adapterId: "claude", sessionId: "ace-local", nativeSessionId: input.session_id });
    expect(instance.events.some((event) => event.nativeSessionId)).toBe(false);
    release(); await settle();
    instance.query.emit(echo(String(input.uuid), String(input.session_id))); expect(await sending).toMatchObject({ status: "ok" }); await settle();
    expect(instance.events.find((event) => event.type === "turn.started")).toMatchObject({ nativeSessionId: input.session_id, turnId: input.uuid });
    await instance.adapter.dispose({ type: "session.dispose", session: { ...instance.session, nativeSessionId: String(input.session_id) } });
  });

  it("stamps exact ordinary user input and requires echo, result, and authoritative idle in either order", async () => {
    const instance = await rig(); const { input, turnId, nativeId } = await startTurn(instance);
    expect(input).toEqual({ type: "user", message: { role: "user", content: "Synthetic prompt" }, parent_tool_use_id: null,
      uuid: turnId, session_id: nativeId });
    instance.query.emit(streamDelta(turnId, nativeId, "Hello")); instance.query.emit(idle(nativeId)); await settle();
    expect(instance.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(instance.events.some((event) => event.type === "turn.completed")).toBe(false);
    instance.query.emit(result(turnId, nativeId)); await settle();
    expect(instance.events.find((event) => event.type === "conversation.delta")).toMatchObject({ role: "assistant", text: "Hello" });
    expect(instance.events.filter((event) => event.type === "turn.completed")).toEqual([
      expect.objectContaining({ turnId, outcome: "completed", result: "Hello" }),
    ]);
    const nextSend = instance.adapter.sendInput({ type: "session.input", session: { ...instance.session, nativeSessionId: nativeId }, input: "Next" });
    const next = await instance.query.takeInput(); instance.query.emit(echo(String(next.uuid), nativeId));
    expect(await nextSend).toMatchObject({ status: "ok" });
  });

  it("does not guess readiness when either result or idle is missing", async () => {
    const instance = await rig({ reconciliationTimeoutMs: 10 }); const { turnId, nativeId } = await startTurn(instance);
    instance.query.emit(result(turnId, nativeId));
    await vi.waitFor(() => expect(instance.events.find((event) => event.type === "session.error")).toMatchObject({ error: { code: "claude_turn_reconciliation_timeout" } }));
    expect(instance.events.find((event) => event.type === "turn.completed")).toMatchObject({ outcome: "failed" });
  });

  it("maps errors and native abort reasons without treating is_error success as success", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance);
    instance.query.emit(result(turnId, nativeId, { is_error: true, terminal_reason: "aborted_streaming" })); instance.query.emit(idle(nativeId)); await settle();
    expect(instance.events.find((event) => event.type === "turn.completed")).toMatchObject({ outcome: "interrupted" });
  });

  it("binds duplicate native permission callbacks to one correlated local approval", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance);
    instance.query.emit(echo(turnId, nativeId)); await settle();
    const controller = new AbortController(); const options = instance.sdk.queryCalls[0].options;
    const detail = { signal: controller.signal, toolUseID: "tool-1", requestId: "request-1", decisionReason: "native ask" };
    const first = options.canUseTool("Bash", { command: "echo synthetic" }, detail);
    const second = options.canUseTool("Bash", { command: "echo synthetic" }, detail); await settle();
    const requested = instance.events.filter((event) => event.type === "approval.requested"); expect(requested).toHaveLength(1);
    const approval = requested[0]; if (approval.type !== "approval.requested") throw new Error("missing approval");
    expect(approval.nativeDetails).toMatchObject({ toolName: "Bash", input: { command: "echo synthetic" }, requestId: "request-1", toolUseId: "tool-1" });
    expect(await instance.adapter.respondToApproval({ type: "approval.respond", session: { ...instance.session, nativeSessionId: nativeId },
      approvalId: approval.approvalId, correlationId: approval.correlationId, decision: "allow_once" })).toMatchObject({ status: "ok" });
    expect(await first).toEqual({ behavior: "allow", updatedInput: { command: "echo synthetic" }, toolUseID: "tool-1" });
    expect(await second).toEqual(await first);
  });

  it("cancels pending permission callbacks on abort without granting a tool", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance); instance.query.emit(echo(turnId, nativeId)); await settle();
    const controller = new AbortController(); const pending = instance.sdk.queryCalls[0].options.canUseTool("Write", { file_path: "x" },
      { signal: controller.signal, toolUseID: "tool-x", requestId: "request-x" });
    await settle(); controller.abort();
    await expect(pending).resolves.toMatchObject({ behavior: "deny", toolUseID: "tool-x" });
  });

  it("reports native tools and only native structured Edit changes without retaining content", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance); instance.query.emit(echo(turnId, nativeId));
    instance.query.emit({ type: "assistant", session_id: nativeId, uuid: "assistant-frame", parent_tool_use_id: null,
      message: { id: "assistant-1", content: [{ type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "safe.ts", old_string: "secret-old", new_string: "secret-new" } }] } });
    instance.query.emit({ type: "user", session_id: nativeId, uuid: "tool-result", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "edit-1", content: "done" }] },
      tool_use_result: { filePath: "safe.ts", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" synthetic"] }],
        gitDiff: { filename: "safe.ts", status: "modified", additions: 1, deletions: 1, changes: 2, patch: "native diff" }, originalFile: "private content" } });
    await settle();
    expect(instance.events.find((event) => event.type === "change.reported")).toMatchObject({ files: [{ path: "safe.ts", kind: "modified" }],
      nativeDetails: { gitDiff: "native diff", structuredPatch: expect.any(Array) } });
    const change = instance.events.find((event) => event.type === "change.reported");
    expect(JSON.stringify(change)).not.toContain("private content");
  });

  it("maps only verified local-agent task messages as workers", async () => {
    const instance = await rig(); const { nativeId } = await startTurn(instance);
    instance.query.emit({ type: "system", subtype: "task_started", task_id: "shell", task_type: "local_bash", description: "shell", session_id: nativeId, uuid: "t1" });
    instance.query.emit({ type: "system", subtype: "task_started", task_id: "agent", task_type: "local_agent", subagent_type: "Explore", description: "inspect", session_id: nativeId, uuid: "t2" });
    instance.query.emit({ type: "system", subtype: "task_updated", task_id: "agent", patch: { status: "completed" }, session_id: nativeId, uuid: "t3" }); await settle();
    expect(instance.events.filter((event) => event.type === "worker.status").map((event) => event.workerId)).toEqual(["agent", "agent"]);
  });

  it("closes an input that remains queued after one native interrupt receipt", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance); instance.query.interruptReceipt = { still_queued: [turnId] };
    const interrupted = await instance.adapter.interrupt({ type: "session.interrupt", session: { ...instance.session, nativeSessionId: nativeId }, reason: "user" });
    expect(interrupted).toMatchObject({ status: "ok" }); expect(instance.query.closed).toBe(true); expect(instance.query.returned).toBe(true);
    expect(instance.events.find((event) => event.type === "turn.completed")).toMatchObject({ outcome: "interrupted" });
  });

  it("independently verifies local registration and native metadata before resume", async () => {
    const cwd = await workspace(); const nativeId = "native-saved"; const saved = { adapterId: "claude", sessionId: "old-local", nativeSessionId: nativeId,
      workspace: await captureWorkspaceIdentity(cwd), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const store = { resolveForResume: vi.fn(async () => saved) }; const sdk = new SyntheticClaudeSdk(); sdk.sessionInfo = { sessionId: nativeId, cwd, summary: "ignored private transcript" };
    sdk.filteredSettings = { permissions: { defaultMode: "dontAsk" } };
    const adapter = new ClaudeNativeHarnessAdapter({ sessionStore: store, sdkFactory: async () => sdk,
      environment: { ANTHROPIC_API_KEY: "synthetic" }, createId: ids() });
    const opened = await adapter.resume({ type: "session.resume", registeredSessionId: "old-local", sessionId: "new-local", nativeSessionId: nativeId, workspace: cwd });
    expect(opened).toMatchObject({ status: "ok", value: { adapterId: "claude", sessionId: "new-local", nativeSessionId: nativeId } });
    expect(sdk.getSessionInfoCalls).toEqual([{ sessionId: nativeId, options: { dir: cwd } }]);
    expect(sdk.queryCalls[0].options).toMatchObject({ resume: nativeId, permissionMode: "dontAsk" });
    expect(sdk.queryCalls[0].options).not.toHaveProperty("sessionId"); expect(sdk.queryCalls[0].options).not.toHaveProperty("model");
    if (opened.status === "ok") await adapter.dispose({ type: "session.dispose", session: opened.value });
  });

  it("rejects mismatched resume metadata without opening a query", async () => {
    const cwd = await workspace(); const saved = { adapterId: "claude", sessionId: "old", nativeSessionId: "native",
      workspace: await captureWorkspaceIdentity(cwd), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const sdk = new SyntheticClaudeSdk(); sdk.sessionInfo = undefined;
    const adapter = new ClaudeNativeHarnessAdapter({ sessionStore: { resolveForResume: async () => saved }, sdkFactory: async () => sdk,
      environment: { ANTHROPIC_API_KEY: "synthetic" } });
    const opened = await adapter.resume({ type: "session.resume", registeredSessionId: "old", sessionId: "new", nativeSessionId: "native", workspace: cwd });
    expect(opened).toMatchObject({ status: "error", code: "claude_resume_unavailable" }); expect(sdk.queryCalls).toHaveLength(0);
  });

  it("rejects mismatched native init identity and does not call the confirmation hook", async () => {
    const instance = await rig(); const sending = instance.adapter.sendInput({ type: "session.input", session: instance.session, input: "Mismatch" });
    const input = await instance.query.takeInput();
    instance.query.emit(init(String(input.session_id), instance.cwd, { claude_code_version: "other" }));
    await vi.waitFor(() => expect(instance.events.find((event) => event.type === "session.error")).toBeTruthy());
    expect(await sending).toMatchObject({ status: "error" });
    expect(instance.hook).not.toHaveBeenCalled();
  });

  it("reserves startup synchronously so concurrent starts cannot create two SDK queries", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk();
    let release!: () => void; const factoryBarrier = new Promise<void>((resolve) => { release = resolve; });
    const factory = vi.fn(async () => { await factoryBarrier; return sdk; });
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: factory, environment: { ANTHROPIC_API_KEY: "synthetic" }, initializationTimeoutMs: 100 });
    const first = adapter.start({ type: "session.start", sessionId: "one", workspace: cwd });
    const second = await adapter.start({ type: "session.start", sessionId: "two", workspace: cwd });
    expect(second).toMatchObject({ status: "rejected", code: "invalid_state" });
    release(); const opened = await first; expect(opened.status).toBe("ok"); expect(factory).toHaveBeenCalledOnce(); expect(sdk.queryCalls).toHaveLength(1);
    if (opened.status === "ok") await adapter.dispose({ type: "session.dispose", session: opened.value });
  });

  it("cancels and awaits a startup blocked inside the lazy SDK factory", async () => {
    const cwd = await workspace(); let entered!: () => void; const startedFactory = new Promise<void>((resolve) => { entered = resolve; });
    const never = new Promise<SyntheticClaudeSdk>(() => {});
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => { entered(); return never; }, environment: { ANTHROPIC_API_KEY: "synthetic" } });
    const starting = adapter.start({ type: "session.start", sessionId: "opening", workspace: cwd }); await startedFactory;
    const disposed = await adapter.dispose({ type: "session.dispose", session: { adapterId: "claude", sessionId: "opening" } });
    expect(disposed).toMatchObject({ status: "ok" }); expect(await starting).toMatchObject({ status: "error", code: "claude_open_cancelled" });
  });

  it("bounds pre-input initialization and closes the owned query on timeout", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk(); sdk.initialization = new Promise(() => {});
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" }, initializationTimeoutMs: 10, cleanupTimeoutMs: 50 });
    const opened = await adapter.start({ type: "session.start", sessionId: "timeout", workspace: cwd });
    expect(opened).toMatchObject({ status: "error", code: "claude_initialization_timeout" });
    expect(sdk.queries[0]).toMatchObject({ closed: true, returned: true });
  });

  it("cancels startup while initialization is pending and waits for owned query cleanup", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk(); sdk.initialization = new Promise(() => {});
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" }, initializationTimeoutMs: 1_000, cleanupTimeoutMs: 50 });
    const starting = adapter.start({ type: "session.start", sessionId: "initializing", workspace: cwd });
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(1));
    const disposed = await adapter.dispose({ type: "session.dispose", session: { adapterId: "claude", sessionId: "initializing" } });
    expect(disposed).toMatchObject({ status: "ok" }); expect(await starting).toMatchObject({ status: "error", code: "claude_open_cancelled" });
    expect(sdk.queries[0]).toMatchObject({ closed: true, returned: true });
  });

  it("retains a session after unconfirmed cleanup and permits an explicit cleanup retry", async () => {
    const instance = await rig(); instance.query.returnError = new Error("synthetic return failure");
    const first = await instance.adapter.dispose({ type: "session.dispose", session: instance.session });
    expect(first).toMatchObject({ status: "error", code: "claude_cleanup_incomplete" });
    instance.query.returnError = undefined;
    const second = await instance.adapter.dispose({ type: "session.dispose", session: instance.session });
    expect(second).toMatchObject({ status: "ok", value: { disposed: true } });
  });

  it("requires a native echo before accepting input and never resubmits an unknown send", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk();
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" }, inputAckTimeoutMs: 10, cleanupTimeoutMs: 50 });
    const opened = await adapter.start({ type: "session.start", sessionId: "ack", workspace: cwd }); if (opened.status !== "ok") throw new Error(opened.message);
    const sending = adapter.sendInput({ type: "session.input", session: opened.value, input: "once" });
    const input = await sdk.queries[0].takeInput(); sdk.queries[0].emit(init(String(input.session_id), cwd));
    expect(await sending).toMatchObject({ status: "error", code: "claude_input_acknowledgement_timeout" });
    expect(sdk.queries[0].inputs).toHaveLength(1);
    await adapter.dispose({ type: "session.dispose", session: opened.value });
  });

  it("does not queue input after a synchronous observer closes the session", async () => {
    const instance = await rig(); let armed = false; let disposing: Promise<unknown> | undefined;
    instance.adapter.observe({ type: "session.observe", session: instance.session }, (event) => {
      if (armed && event.type === "session.state" && event.state === "running") {
        disposing = instance.adapter.dispose({ type: "session.dispose", session: instance.session });
      }
    });
    armed = true;
    const sent = await instance.adapter.sendInput({ type: "session.input", session: instance.session, input: "must not queue" });
    expect(sent).toMatchObject({ status: "rejected", code: "invalid_state" }); await disposing;
    expect(instance.query.inputs).toHaveLength(0);
  });

  it("settles streamed text and preserves distinct complete content frames sharing an API message ID", async () => {
    const instance = await rig(); const { nativeId } = await startTurn(instance);
    instance.query.emit({ type: "assistant", session_id: nativeId, uuid: "complete-a", parent_tool_use_id: null,
      message: { id: "message-a", content: [{ type: "text", text: "Complete fallback" }] } });
    instance.query.emit({ type: "stream_event", session_id: nativeId, uuid: "partial-start", parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "message-b" } } });
    instance.query.emit({ type: "stream_event", session_id: nativeId, uuid: "partial-delta-1", parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Stream" } } });
    instance.query.emit({ type: "stream_event", session_id: nativeId, uuid: "partial-delta-2", parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ed" } } });
    instance.query.emit({ type: "assistant", session_id: nativeId, uuid: "complete-b", parent_tool_use_id: null,
      message: { id: "message-b", content: [{ type: "text", text: "Streamed" }] } });
    instance.query.emit({ type: "assistant", session_id: nativeId, uuid: "complete-c", parent_tool_use_id: null,
      message: { id: "message-b", content: [{ type: "text", text: "Second block" }] } }); await settle();
    expect(instance.events.filter((event) => event.type === "conversation.message")).toEqual([
      expect.objectContaining({ text: "Complete fallback", nativeMessageId: "root:message-a:0" }),
      expect.objectContaining({ text: "Streamed", nativeMessageId: "root:message-b:0" }),
      expect.objectContaining({ text: "Second block", nativeMessageId: "root:message-b:1" }),
    ]);
    expect(instance.events.filter((event) => event.type === "conversation.delta" && event.nativeMessageId === "root:message-b:0").map((event) => event.text)).toEqual(["Stream", "ed"]);
  });

  it("ignores stale correlated frames from a completed turn while a later turn is active", async () => {
    const instance = await rig(); const first = await startTurn(instance); instance.query.emit(result(first.turnId, first.nativeId)); instance.query.emit(idle(first.nativeId)); await settle();
    const sending = instance.adapter.sendInput({ type: "session.input", session: { ...instance.session, nativeSessionId: first.nativeId }, input: "second" });
    const second = await instance.query.takeInput();
    instance.query.emit({ ...echo(first.turnId, first.nativeId), event: { type: "content_block_delta", delta: { type: "text_delta", text: "STALE" } } });
    instance.query.emit(echo(String(second.uuid), first.nativeId)); expect(await sending).toMatchObject({ status: "ok" }); await settle();
    expect(instance.events.some((event) => (event.type === "conversation.delta" || event.type === "conversation.message") && /STALE/.test(event.text))).toBe(false);
  });


  it("holds a permission callback behind native identity confirmation without granting it", async () => {
    const instance = await rig();
    const sending = instance.adapter.sendInput({ type: "session.input", session: instance.session, input: "permission race" });
    const input = await instance.query.takeInput(); const nativeId = String(input.session_id); const turnId = String(input.uuid);
    const controller = new AbortController();
    const permission = instance.sdk.queryCalls[0].options.canUseTool("Bash", { command: "echo synthetic" },
      { signal: controller.signal, toolUseID: "pre-tool", requestId: "pre-request" });
    await settle(); expect(instance.events.some((event) => event.type === "approval.requested")).toBe(false);
    instance.query.emit(init(nativeId, instance.cwd));
    await vi.waitFor(() => expect(instance.events.some((event) => event.type === "approval.requested")).toBe(true));
    const request = instance.events.find((event) => event.type === "approval.requested");
    if (!request || request.type !== "approval.requested") throw new Error("missing request");
    await instance.adapter.respondToApproval({ type: "approval.respond", session: { ...instance.session, nativeSessionId: nativeId },
      approvalId: request.approvalId, correlationId: request.correlationId, decision: "deny" });
    await expect(permission).resolves.toMatchObject({ behavior: "deny", toolUseID: "pre-tool" });
    instance.query.emit(echo(turnId, nativeId)); expect(await sending).toMatchObject({ status: "ok" });
  });

  it("retains ownership when startup failure cleanup is unconfirmed, then permits disposal retry", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk();
    let rejectInitialization!: (error: Error) => void;
    sdk.initialization = new Promise((_resolve, reject) => { rejectInitialization = reject; });
    sdk.configureQuery = (query) => { query.returnError = new Error("synthetic return failure"); };
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" }, cleanupTimeoutMs: 50 });
    const opening = adapter.start({ type: "session.start", sessionId: "failed-open", workspace: cwd });
    await vi.waitFor(() => expect(sdk.queries).toHaveLength(1)); rejectInitialization(new Error("synthetic initialization failure"));
    const opened = await opening;
    expect(opened).toMatchObject({ status: "error" });
    expect(await adapter.start({ type: "session.start", sessionId: "must-not-open", workspace: cwd })).toMatchObject({ status: "rejected", code: "invalid_state" });
    sdk.queries[0].returnError = undefined;
    expect(await adapter.dispose({ type: "session.dispose", session: { adapterId: "claude", sessionId: "failed-open" } })).toMatchObject({ status: "ok" });
    expect(sdk.queryCalls).toHaveLength(1);
  });


  it("attaches the local turn ID to every active event for shared-state correlation", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance);
    instance.query.emit({ type: "assistant", session_id: nativeId, uuid: "tool-frame", parent_tool_use_id: null,
      message: { id: "api-message", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "echo" } }] } });
    instance.query.emit(result(turnId, nativeId)); instance.query.emit(idle(nativeId)); await settle();
    const active = instance.events.filter((event) => ["session.state", "turn.started", "conversation.delta", "tool.activity", "turn.completed"].includes(event.type) && event.sequence > 1);
    expect(active.length).toBeGreaterThan(0); expect(active.every((event) => event.turnId === turnId)).toBe(true);
  });

  it("treats unknown successful terminal reasons as failure and projects authoritative permission denials", async () => {
    const instance = await rig(); const { turnId, nativeId } = await startTurn(instance);
    instance.query.emit(result(turnId, nativeId, { terminal_reason: "tool_deferred", permission_denials: [
      { tool_name: "Write", tool_use_id: "denied-tool", tool_input: { file_path: "safe.ts", content: "must-not-emit" } },
    ] })); instance.query.emit(idle(nativeId)); await settle();
    expect(instance.events.find((event) => event.type === "tool.activity" && event.toolCallId === "denied-tool")).toMatchObject({
      state: "failed", nativeState: "permission_denied", nativeDetails: { authoritativeResultDenial: true }, turnId,
    });
    expect(JSON.stringify(instance.events)).not.toContain("must-not-emit");
    expect(instance.events.find((event) => event.type === "turn.completed")).toMatchObject({ outcome: "failed" });
  });

  it("does not report a change for a failed Edit result", async () => {
    const instance = await rig(); const { nativeId } = await startTurn(instance);
    instance.query.emit({ type: "assistant", session_id: nativeId, uuid: "edit-frame", parent_tool_use_id: null,
      message: { id: "api-edit", content: [{ type: "tool_use", id: "failed-edit", name: "Edit", input: { file_path: "safe.ts" } }] } });
    instance.query.emit({ type: "user", session_id: nativeId, uuid: "failed-result", parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "failed-edit", is_error: true, content: "denied" }] },
      tool_use_result: { filePath: "safe.ts", structuredPatch: [], originalFile: "hidden" } }); await settle();
    expect(instance.events.some((event) => event.type === "change.reported" && event.changeId === "failed-edit")).toBe(false);
  });

  it("denies unsupported structured questions without creating a generic approval", async () => {
    const instance = await rig(); await startTurn(instance); const controller = new AbortController();
    const answer = await instance.sdk.queryCalls[0].options.canUseTool("AskUserQuestion", { questions: [] },
      { signal: controller.signal, toolUseID: "question", requestId: "question-request" });
    expect(answer).toMatchObject({ behavior: "deny", toolUseID: "question" });
    expect(instance.events.some((event) => event.type === "approval.requested" && event.nativeApprovalId === "question")).toBe(false);
  });


  it("resolves a permission cancelled synchronously during publication and never allows it", async () => {
    const instance = await rig(); await startTurn(instance); const controller = new AbortController();
    instance.adapter.observe({ type: "session.observe", session: { ...instance.session, nativeSessionId: instance.session.nativeSessionId } }, (event) => {
      if (event.type === "approval.requested" && event.nativeApprovalId === "abort-tool") controller.abort();
    });
    const answer = await instance.sdk.queryCalls[0].options.canUseTool("Bash", { command: "echo" },
      { signal: controller.signal, toolUseID: "abort-tool", requestId: "abort-request" });
    expect(answer).toMatchObject({ behavior: "deny", toolUseID: "abort-tool" });
    expect(instance.events.filter((event) => event.nativeApprovalId === "abort-tool").map((event) => event.type)).toEqual([
      "approval.requested", "approval.resolved",
    ]);
  });

  it("keeps resolved native request tombstones across later turns without retaining their input", async () => {
    const instance = await rig(); const first = await startTurn(instance); const controller = new AbortController();
    const detail = { signal: controller.signal, toolUseID: "reused-tool", requestId: "reused-request" };
    const original = instance.sdk.queryCalls[0].options.canUseTool("Bash", { command: "first" }, detail); await settle();
    const request = instance.events.find((event) => event.type === "approval.requested" && event.nativeApprovalId === "reused-tool");
    if (!request || request.type !== "approval.requested") throw new Error("missing request");
    await instance.adapter.respondToApproval({ type: "approval.respond", session: { ...instance.session, nativeSessionId: first.nativeId },
      approvalId: request.approvalId, correlationId: request.correlationId, decision: "deny" }); await original;
    instance.query.emit(result(first.turnId, first.nativeId)); instance.query.emit(idle(first.nativeId)); await settle();
    const sending = instance.adapter.sendInput({ type: "session.input", session: { ...instance.session, nativeSessionId: first.nativeId }, input: "next" });
    const next = await instance.query.takeInput(); instance.query.emit(echo(String(next.uuid), first.nativeId)); await sending;
    const before = instance.events.filter((event) => event.type === "approval.requested").length;
    const late = await instance.sdk.queryCalls[0].options.canUseTool("Bash", { command: "must not replace" }, detail);
    expect(late).toMatchObject({ behavior: "deny", message: expect.stringMatching(/stale/) });
    expect(instance.events.filter((event) => event.type === "approval.requested")).toHaveLength(before);
  });

  it("denies new permission prompts after interrupt has claimed the active turn", async () => {
    const instance = await rig(); const { nativeId } = await startTurn(instance);
    const interrupting = instance.adapter.interrupt({ type: "session.interrupt", session: { ...instance.session, nativeSessionId: nativeId } });
    const answer = await instance.sdk.queryCalls[0].options.canUseTool("Bash", { command: "too late" },
      { signal: new AbortController().signal, toolUseID: "late-tool", requestId: "late-request" });
    expect(answer).toMatchObject({ behavior: "deny" }); expect(await interrupting).toMatchObject({ status: "ok" });
    expect(instance.events.some((event) => event.type === "approval.requested" && event.nativeApprovalId === "late-tool")).toBe(false);
  });

  it("does not enqueue when an observer synchronously interrupts the prequeue reservation", async () => {
    const instance = await rig(); let armed = false; let interrupting: Promise<unknown> | undefined;
    instance.adapter.observe({ type: "session.observe", session: instance.session }, (event) => {
      if (armed && event.type === "session.state" && event.nativeState === "queued_awaiting_native_identity") {
        interrupting = instance.adapter.interrupt({ type: "session.interrupt", session: instance.session });
      }
    });
    armed = true;
    const sent = await instance.adapter.sendInput({ type: "session.input", session: instance.session, input: "cancel before queue" });
    expect(sent).toMatchObject({ status: "rejected", code: "invalid_state" }); expect(await interrupting).toMatchObject({ status: "ok" });
    expect(instance.query.inputs).toHaveLength(0);
  });


  it.each(["plan", "dontAsk"] as const)("resolves and explicitly preserves the supported %s permission mode", async (mode) => {
    const sdk = new SyntheticClaudeSdk(); sdk.filteredSettings = { permissions: { defaultMode: mode } };
    const instance = await rig({ sdk });
    expect(sdk.resolveSettingsCalls).toEqual([{ cwd: instance.cwd, settingSources: ["user", "project", "local"] }]);
    expect(sdk.queryCalls[0].options.permissionMode).toBe(mode);
    await instance.adapter.dispose({ type: "session.dispose", session: instance.session });
  });

  it("uses the vendor trust filter and defaults when it removes a project escalation", async () => {
    const sdk = new SyntheticClaudeSdk();
    sdk.resolvedSettings = { effective: { permissions: { defaultMode: "acceptEdits" } },
      sources: [{ source: "project", settings: { permissions: { defaultMode: "acceptEdits" } } }] };
    sdk.filteredSettings = {};
    const instance = await rig({ sdk }); expect(sdk.queryCalls[0].options.permissionMode).toBe("default");
    await instance.adapter.dispose({ type: "session.dispose", session: instance.session });
  });

  it("fails closed on retained escalating modes before creating a query", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk(); sdk.filteredSettings = { permissions: { defaultMode: "acceptEdits" } };
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" } });
    expect(await adapter.start({ type: "session.start", sessionId: "unsupported-mode", workspace: cwd })).toMatchObject({
      status: "error", code: "claude_permission_mode_unsupported",
    });
    expect(sdk.queryCalls).toHaveLength(0);
  });

  it.each([
    { effective: { policyHelper: { command: "synthetic" } }, sources: [] },
    { effective: {}, sources: [{ source: "managed", settings: { policyHelpers: [] } }] },
    { effective: {}, sources: [{ source: "managed", settings: {}, policyOrigin: "helper" }] },
    { effective: {}, sources: [], provenance: { permissions: { policyOrigin: "helper" } } },
  ])("rejects visible policy-helper configuration without executing it", async (resolved) => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk(); sdk.resolvedSettings = resolved;
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" } });
    expect(await adapter.start({ type: "session.start", sessionId: "policy-helper", workspace: cwd })).toMatchObject({
      status: "error", code: "claude_policy_helper_unsupported",
    });
    expect(sdk.queryCalls).toHaveLength(0);
  });

  it("reports public settings resolution failures without opening a query", async () => {
    const cwd = await workspace(); const sdk = new SyntheticClaudeSdk(); sdk.resolveSettingsError = new Error("synthetic settings failure");
    const adapter = new ClaudeNativeHarnessAdapter({ sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic" } });
    expect(await adapter.start({ type: "session.start", sessionId: "settings-failure", workspace: cwd })).toMatchObject({
      status: "error", code: "claude_settings_resolution_failed",
    });
    expect(sdk.queryCalls).toHaveLength(0);
  });

  it("rejects a custom production environment because settings resolution would use another environment", () => {
    expect(() => new ClaudeNativeHarnessAdapter({ environment: { ANTHROPIC_API_KEY: "synthetic" } })).toThrow(/injected SDK boundary/);
  });

  it("allows a synchronous ready observer to reserve and queue the next turn", async () => {
    const instance = await rig(); const first = await startTurn(instance); let armed = false; let nextSend: Promise<unknown> | undefined;
    instance.adapter.observe({ type: "session.observe", session: instance.session }, (event) => {
      if (armed && event.type === "session.state" && event.state === "ready") {
        armed = false; nextSend = instance.adapter.sendInput({ type: "session.input", session: instance.session, input: "reentrant next" });
      }
    });
    armed = true; instance.query.emit(result(first.turnId, first.nativeId)); instance.query.emit(idle(first.nativeId));
    await vi.waitFor(() => expect(nextSend).toBeDefined()); const next = await instance.query.takeInput();
    instance.query.emit(echo(String(next.uuid), first.nativeId)); expect(await nextSend).toMatchObject({ status: "ok" });
  });

  it("reserves cleanup before cancellation observers can reenter disposal", async () => {
    const instance = await rig(); const { nativeId } = await startTurn(instance); const controller = new AbortController();
    const pending = instance.sdk.queryCalls[0].options.canUseTool("Bash", { command: "echo" },
      { signal: controller.signal, toolUseID: "cleanup-tool", requestId: "cleanup-request" }); await settle();
    let nested: Promise<unknown> | undefined;
    instance.adapter.observe({ type: "session.observe", session: instance.session }, (event) => {
      if (!nested && event.type === "approval.resolved") nested = instance.adapter.dispose({ type: "session.dispose", session: { ...instance.session, nativeSessionId: nativeId } });
    });
    const outer = instance.adapter.dispose({ type: "session.dispose", session: { ...instance.session, nativeSessionId: nativeId } });
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    expect(await outer).toMatchObject({ status: "ok" }); expect(await nested).toMatchObject({ status: "ok" });
    expect(instance.query.closeCalls).toBe(1); expect(instance.query.returnCalls).toBe(1);
  });

  it("invalidates every approval before publishing cancellation events", async () => {
    const instance = await rig(); const { nativeId } = await startTurn(instance);
    const options = instance.sdk.queryCalls[0].options; const signal = new AbortController().signal;
    const first = options.canUseTool("Bash", { command: "one" }, { signal, toolUseID: "atomic-one", requestId: "atomic-request-one" });
    const second = options.canUseTool("Bash", { command: "two" }, { signal, toolUseID: "atomic-two", requestId: "atomic-request-two" });
    await vi.waitFor(() => expect(instance.events.filter((event) => event.type === "approval.requested" && String(event.nativeApprovalId).startsWith("atomic-"))).toHaveLength(2));
    let attempted: Promise<unknown> | undefined;
    const secondRequest = instance.events.find((event) => event.type === "approval.requested" && event.nativeApprovalId === "atomic-two");
    if (!secondRequest || secondRequest.type !== "approval.requested") throw new Error("missing second approval");
    instance.adapter.observe({ type: "session.observe", session: instance.session }, (event) => {
      if (!attempted && event.type === "approval.resolved" && event.nativeApprovalId === "atomic-one") {
        attempted = instance.adapter.respondToApproval({ type: "approval.respond", session: { ...instance.session, nativeSessionId: nativeId },
          approvalId: secondRequest.approvalId, correlationId: secondRequest.correlationId, decision: "allow_once" });
      }
    });
    await instance.adapter.interrupt({ type: "session.interrupt", session: { ...instance.session, nativeSessionId: nativeId } });
    await expect(first).resolves.toMatchObject({ behavior: "deny" }); await expect(second).resolves.toMatchObject({ behavior: "deny" });
    expect(await attempted).toMatchObject({ status: "rejected", code: "stale_approval" });
  });

});
