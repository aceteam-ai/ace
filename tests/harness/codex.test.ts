import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexNativeHarnessAdapter, TESTED_CODEX_VERSION,
  type CodexProcessFactory, type NativeHarnessEvent, type NativeHarnessSessionIdentity,
} from "../../src/harness/index.js";
import { CodexRpc, type JsonObject } from "../../src/harness/codex-protocol.js";

type Wire = Record<string, any>;
const threadId = "thread-synthetic";
const turnId = "turn-synthetic";
const scope = { threadId, turnId };
const turn = (status = "inProgress", error: unknown = null) => ({ id: turnId, status, items: [], error });
const workspace = "/synthetic/workspace";
const startCommand = { type: "session.start" as const, sessionId: "session-synthetic", workspace };

class SyntheticChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  messages: Wire[] = [];
  signals: NodeJS.Signals[] = [];
  ignoreTerm = false;
  failWrite = false;
  hangWrite = false;
  handle: (request: Wire) => void = () => {};
  constructor() {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      if (this.failWrite) { callback(new Error("synthetic write failure")); return; }
      const request = JSON.parse(chunk.toString());
      this.messages.push(request);
      if (this.hangWrite) return;
      callback();
      queueMicrotask(() => this.handle(request));
    } });
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (this.ignoreTerm && signal === "SIGTERM") return true;
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = signal;
      this.stdout.end();
      this.stderr.end();
      this.emit("close", null, signal);
    });
    return true;
  }
  exit(code: number) { this.exitCode = code; this.emit("close", code, null); }
  send(message: Wire) { this.stdout.write(`${JSON.stringify(message)}\n`); }
  notify(method: string, params: Wire) { this.send({ method, params }); }
  reply(request: Wire, result: Wire) { this.send({ id: request.id, result }); }
  asChild() { return this as unknown as ChildProcessWithoutNullStreams; }
}

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(disposals.splice(0).map((dispose) => dispose())); vi.useRealTimers(); });

function rig(options: {
  version?: string; auth?: Wire; initialized?: Wire; started?: Wire;
  handle?: (child: SyntheticChild, request: Wire) => boolean;
  requestTimeoutMs?: number; ignoreTerm?: boolean;
} = {}) {
  const versions: SyntheticChild[] = [];
  const children: SyntheticChild[] = [];
  const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
  const processFactory: CodexProcessFactory = (executable, args, cwd) => {
    calls.push({ executable, args, cwd });
    const child = new SyntheticChild();
    if (args[0] === "--version") {
      versions.push(child);
      queueMicrotask(() => { child.stdout.write(`${options.version ?? "codex-cli 0.153.4"}\n`); child.exit(0); });
    } else {
      children.push(child);
      child.ignoreTerm = options.ignoreTerm ?? false;
      child.handle = (request) => {
        if (options.handle?.(child, request)) return;
        switch (request.method) {
          case "initialize": child.reply(request, options.initialized ?? { userAgent: "synthetic-codex/0.153.4", codexHome: "/synthetic/native-home" }); break;
          case "account/read": child.reply(request, options.auth ?? { account: { type: "chatgpt", email: "synthetic@example.invalid" }, requiresOpenaiAuth: true }); break;
          case "thread/start": child.reply(request, options.started ?? { thread: { id: threadId }, model: "synthetic-model", modelProvider: "synthetic", cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "readOnly" } }); break;
          case "turn/start": child.reply(request, { turn: turn() }); break;
          case "turn/interrupt": child.reply(request, {}); break;
        }
      };
    }
    return child.asChild();
  };
  const adapter = new CodexNativeHarnessAdapter({ processFactory, now: () => "2026-01-01T00:00:00.000Z", requestTimeoutMs: options.requestTimeoutMs ?? 1000, shutdownTimeoutMs: 5 });
  return { adapter, calls, versions, children, get child() { return children.at(-1)!; } };
}

async function running(options: Parameters<typeof rig>[0] = {}) {
  const instance = rig(options);
  const result = await instance.adapter.start(startCommand);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("Synthetic start failed");
  const session = result.value;
  disposals.push(() => instance.adapter.dispose({ type: "session.dispose", session }));
  const events: NativeHarnessEvent[] = [];
  instance.adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
  const resultInput = await instance.adapter.sendInput({ type: "session.input", session, input: "Synthetic prompt" });
  expect(resultInput.status).toBe("ok");
  return { ...instance, child: instance.child, session, events };
}

function approval(child: SyntheticChild, id: string | number = 7, overrides: Wire = {}, method = "item/commandExecution/requestApproval") {
  child.send({ id, method, params: { ...scope, itemId: `item-${id}`, command: "echo synthetic", reason: "Synthetic reason", startedAtMs: 0, ...overrides } });
}
function requestEvent(events: NativeHarnessEvent[], index = 0) {
  const result = events.filter((event) => event.type === "approval.requested")[index];
  if (!result || result.type !== "approval.requested") throw new Error("Missing synthetic approval");
  return result;
}
function response(session: NativeHarnessSessionIdentity, event: ReturnType<typeof requestEvent>, decision = "accept") {
  return { type: "approval.respond" as const, session, approvalId: event.approvalId, correlationId: event.correlationId, decision };
}
function terminal(child: SyntheticChild, status = "completed", error: unknown = null) { child.notify("turn/completed", { threadId, turn: turn(status, error) }); }

// All protocol streams and subprocess output below are synthetic; no credentials or Codex runtime required.
describe("Codex single-session adapter", () => {
  it("performs the documented handshake, preserves native permissions, and exposes no account data", async () => {
    const { adapter, child, session, events, calls } = await running();
    expect(TESTED_CODEX_VERSION).toBe("0.153.4");
    expect(calls).toEqual([
      { executable: "codex", args: ["--version"], cwd: workspace },
      { executable: "codex", args: ["app-server", "--listen", "stdio://"], cwd: workspace },
    ]);
    expect(child.messages.map((message) => message.method)).toEqual(["initialize", "initialized", "account/read", "thread/start", "turn/start"]);
    expect(child.messages[0].params).toMatchObject({ clientInfo: { name: "aceteam_ace" }, capabilities: { experimentalApi: false } });
    expect(child.messages[2].params).toEqual({ refreshToken: false });
    expect(child.messages[3].params).toEqual({ cwd: workspace });
    expect(child.messages[4].params).toEqual({ threadId, input: [{ type: "text", text: "Synthetic prompt", text_elements: [] }] });
    expect(events[0]).toMatchObject({ type: "session.state", state: "ready", nativeDetails: { permissionContext: { sandbox: { type: "readOnly" }, approvalPolicy: "on-request", approvalsReviewer: "user" } } });
    child.notify("account/updated", { email: "hidden@example.invalid", authMode: "chatgpt" });
    expect(JSON.stringify(events)).not.toMatch(/example.invalid|native-home/);
    expect(session).toEqual({ adapterId: "codex", sessionId: startCommand.sessionId, nativeSessionId: threadId });
    expect(adapter.capabilities.resume.supported).toBe(false);
  });

  it("maps native messages, tools, workers and reported changes with IDs and full structured detail", async () => {
    const { child, events } = await running();
    child.notify("item/completed", { ...scope, item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Synthetic prompt" }] } });
    child.notify("item/agentMessage/delta", { ...scope, itemId: "message-1", delta: "Hello " });
    child.notify("item/completed", { ...scope, item: { type: "agentMessage", id: "message-1", text: "Hello world", phase: "final_answer" } });
    child.notify("item/started", { ...scope, item: { id: "cmd-1", type: "commandExecution", command: "echo synthetic", status: "inProgress" } });
    child.notify("item/completed", { ...scope, item: { id: "cmd-1", type: "commandExecution", status: "completed", exitCode: 0, aggregatedOutput: "synthetic" } });
    child.notify("item/completed", { ...scope, item: { id: "file-1", type: "fileChange", status: "completed", changes: [{ path: "example.ts", kind: { type: "update", move_path: null }, diff: "synthetic diff" }] } });
    child.notify("item/completed", { ...scope, item: { id: "collab-1", type: "collabAgentToolCall", status: "completed", tool: "spawnAgent", agentsStates: { "worker-1": { status: "running", message: null } } } });
    child.notify("turn/diff/updated", { ...scope, diff: "synthetic unified diff" });
    terminal(child);
    expect(events).toContainEqual(expect.objectContaining({ type: "conversation.delta", text: "Hello ", nativeMessageId: "message-1", correlationId: turnId }));
    expect(events).toContainEqual(expect.objectContaining({ type: "conversation.message", text: "Hello world", nativeDetails: { method: "item/completed", params: { ...scope, item: { type: "agentMessage", id: "message-1", text: "Hello world", phase: "final_answer" } } } }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.activity", nativeToolCallId: "cmd-1", state: "completed", output: "synthetic" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "change.reported", files: [{ path: "example.ts", kind: "modified" }] }));
    expect(events).toContainEqual(expect.objectContaining({ type: "worker.status", nativeWorkerId: "worker-1", state: "running" }));
    expect(events.at(-1)).toMatchObject({ type: "session.completed", nativeState: "completed" });
    expect(events.every((event) => event.adapterId === "codex" && event.nativeSessionId === threadId && event.timestamp === "2026-01-01T00:00:00.000Z")).toBe(true);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b));
  });

  it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("correlates %s with live native requests and waits for native resolution", async (method) => {
    const { adapter, session, child, events } = await running();
    approval(child, "native-request", { itemId: "item-1", grantRoot: "/synthetic/requested-root" }, method);
    const event = requestEvent(events);
    expect(event.choices).toEqual(["accept", "decline", "cancel"]);
    expect(child.messages.filter((message) => message.result)).toHaveLength(0);
    expect(await adapter.respondToApproval(response(session, event, "acceptForSession"))).toMatchObject({ status: "rejected", code: "invalid_approval_decision" });
    expect(await adapter.respondToApproval({ ...response(session, event), correlationId: "wrong" })).toMatchObject({ status: "rejected", code: "approval_mismatch" });
    expect(await adapter.respondToApproval(response(session, event))).toEqual({ status: "ok", value: { accepted: true } });
    expect(child.messages.at(-1)).toEqual({ id: "native-request", result: { decision: "accept" } });
    expect(events.filter((entry) => entry.type === "approval.resolved")).toHaveLength(0);
    child.notify("serverRequest/resolved", { threadId, requestId: "native-request" });
    expect(events).toContainEqual(expect.objectContaining({ type: "approval.resolved", decision: "accept", correlationId: event.correlationId }));
    expect(await adapter.respondToApproval(response(session, event))).toMatchObject({ status: "rejected", code: "stale_approval" });
  });

  it("isolates numeric/string request IDs, simultaneous approvals, and invalid or concurrent replies", async () => {
    const { adapter, session, child, events } = await running();
    approval(child, 7, { itemId: "one", availableDecisions: ["decline", "cancel"] });
    approval(child, "7", { itemId: "two" });
    const first = requestEvent(events); const second = requestEvent(events, 1);
    expect(first.correlationId).not.toBe(second.correlationId);
    expect(await adapter.respondToApproval(response(session, first))).toMatchObject({ code: "invalid_approval_decision" });
    expect(await adapter.respondToApproval(response({ ...session, sessionId: "other" }, first, "decline"))).toMatchObject({ code: "invalid_session" });
    expect(await adapter.respondToApproval(response({ ...session, adapterId: "other" }, first, "decline"))).toMatchObject({ code: "adapter_mismatch" });
    const answers = await Promise.all([adapter.respondToApproval(response(session, first, "decline")), adapter.respondToApproval(response(session, first, "cancel"))]);
    expect(answers.map((answer) => answer.status)).toEqual(["ok", "rejected"]);
    child.notify("serverRequest/resolved", { threadId, requestId: 7 });
    expect(events.at(-1)).toMatchObject({ type: "session.state", state: "waiting_for_approval" });
    expect(await adapter.respondToApproval(response(session, second, "cancel"))).toMatchObject({ status: "ok" });
    expect(child.messages.filter((message) => message.result)).toEqual([{ id: 7, result: { decision: "decline" } }, { id: "7", result: { decision: "cancel" } }]);
  });

  it.each(["completed", "interrupted", "failed"])("expires pending approvals on terminal %s before callbacks can reply", async (status) => {
    const { adapter, session, child, events } = await running();
    approval(child);
    const event = requestEvent(events);
    const replies: Promise<unknown>[] = [];
    adapter.observe({ type: "session.observe", session }, (entry) => { if (entry.type === "approval.resolved") replies.push(adapter.respondToApproval(response(session, event))); });
    terminal(child, status, status === "failed" ? { message: "synthetic failure" } : null);
    expect(await Promise.all(replies)).toEqual([expect.objectContaining({ status: "rejected", code: "invalid_state" })]);
    expect(await adapter.sendInput({ type: "session.input", session, input: "too late" })).toMatchObject({ status: "rejected", code: "invalid_state" });
    expect(events.filter((entry) => ["session.completed", "session.cancelled", "session.error"].includes(entry.type))).toHaveLength(1);
  });

  it("expires prompts on native resolution or item completion without inventing approval", async () => {
    const { adapter, session, child, events } = await running();
    approval(child, 1); const one = requestEvent(events);
    child.notify("serverRequest/resolved", { threadId, requestId: 1 });
    expect(await adapter.respondToApproval(response(session, one))).toMatchObject({ code: "stale_approval" });
    approval(child, 2); const two = requestEvent(events, 1);
    child.notify("item/completed", { ...scope, item: { type: "commandExecution", id: "item-2", status: "declined" } });
    expect(await adapter.respondToApproval(response(session, two))).toMatchObject({ code: "stale_approval" });
    expect(events.filter((entry) => entry.type === "approval.resolved").map((entry) => entry.decision)).toEqual(["expired", "expired"]);
    expect(child.messages.filter((message) => message.result)).toHaveLength(0);
  });

  it("reports native denial as failed activity without claiming files changed", async () => {
    const { child, events } = await running();
    child.notify("item/completed", { ...scope, item: { type: "fileChange", id: "file-denied", status: "declined", changes: [{ path: "example.ts", kind: { type: "add" }, diff: "proposed only" }] } });
    expect(events.at(-1)).toMatchObject({ type: "tool.activity", state: "failed", nativeState: "declined" });
    expect(events.some((event) => event.type === "change.reported")).toBe(false);
  });

  it("interrupts once and awaits the native terminal outcome instead of fabricating cancellation", async () => {
    const { adapter, session, child, events } = await running();
    approval(child); const pending = requestEvent(events);
    expect(await adapter.interrupt({ type: "session.interrupt", session })).toMatchObject({ status: "ok" });
    expect(await adapter.respondToApproval(response(session, pending))).toMatchObject({ code: "stale_approval" });
    expect(events.some((event) => event.type === "session.cancelled")).toBe(false);
    expect(child.messages.at(-1)).toMatchObject({ method: "turn/interrupt", params: scope });
    expect(await adapter.interrupt({ type: "session.interrupt", session })).toMatchObject({ code: "invalid_state" });
    terminal(child, "interrupted");
    expect(events.at(-1)).toMatchObject({ type: "session.cancelled" });
  });

  it("rejects duplicate IDs and stale approvals after an item has ended", async () => {
    const first = await running();
    approval(first.child); approval(first.child);
    expect(first.events.at(-1)).toMatchObject({ type: "session.error", error: { code: "codex_stale_request" } });
    const second = await running();
    second.child.notify("item/completed", { ...scope, item: { type: "commandExecution", id: "item-7", status: "completed" } });
    approval(second.child);
    expect(second.events.at(-1)).toMatchObject({ type: "session.error", error: { code: "codex_stale_request" } });
  });

  it("preserves unknown notifications but never maps unknown native terminal/tool states to success", async () => {
    const first = await running();
    first.child.notify("item/future/progress", { ...scope, future: { phase: "synthetic" } });
    expect(first.events.at(-1)).toMatchObject({ type: "session.state", nativeState: "item/future/progress", nativeDetails: { params: { future: { phase: "synthetic" } } } });
    terminal(first.child, "future-state");
    expect(first.events.at(-1)).toMatchObject({ type: "session.error", error: { code: "incompatible_codex_protocol" } });
    const second = await running();
    second.child.notify("item/completed", { ...scope, item: { id: "future", type: "commandExecution", status: "future-state" } });
    expect(second.events.at(-1)).toMatchObject({ type: "session.error" });
  });

  it("ignores other-thread notifications but fails closed on mismatched approval requests", async () => {
    const { child, events } = await running(); const count = events.length;
    child.notify("item/agentMessage/delta", { ...scope, threadId: "foreign", itemId: "foreign-message", delta: "foreign" });
    expect(events).toHaveLength(count);
    approval(child, 7, { threadId: "foreign" });
    expect(events.at(-1)).toMatchObject({ type: "session.error", error: { code: "incompatible_codex_protocol" } });
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("rejects unsupported native user-input/permission requests without auto-approval", async () => {
    const { child, events } = await running();
    child.send({ id: "unsupported", method: "item/permissions/requestApproval", params: { ...scope, itemId: "permission" } });
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "session.error", error: { code: "unsupported_codex_request" } }));
    expect(child.messages.at(-1)).toEqual({ id: "unsupported", error: { code: -32601, message: "Ace supports command and file approvals only." } });
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("treats native retry errors as running and auth failures as actionable terminal errors", async () => {
    const { child, events } = await running();
    child.notify("error", { ...scope, willRetry: true, error: { message: "Synthetic transient failure" } });
    expect(events.at(-1)).toMatchObject({ type: "session.state", nativeState: "retrying" });
    child.notify("error", { ...scope, willRetry: false, error: { message: "Synthetic auth failure", codexErrorInfo: "Unauthorized" } });
    expect(events.at(-1)).toMatchObject({ type: "session.error", error: { code: "codex_authentication_required", message: expect.stringContaining("codex login") } });
  });

  it("prevents observer mutation or exceptions from altering replies or other observers", async () => {
    const { adapter, child, session, events } = await running();
    adapter.observe({ type: "session.observe", session }, (event) => { if (event.type === "approval.requested") { (event.choices as string[]).push("acceptForSession"); (event.nativeDetails as Record<string, unknown>).requestId = "tampered"; } throw new Error("synthetic renderer error"); });
    approval(child);
    const pending = requestEvent(events);
    expect(await adapter.respondToApproval(response(session, pending, "acceptForSession"))).toMatchObject({ code: "invalid_approval_decision" });
    expect(await adapter.respondToApproval(response(session, pending))).toMatchObject({ status: "ok" });
    expect(child.messages.at(-1)).toEqual({ id: 7, result: { decision: "accept" } });
    expect(events.some((event) => event.type === "session.error")).toBe(false);
  });

  it.each(["__proto__", "constructor", "shutdown", "future"])("preserves unnormalized worker state %s without inventing a generic outcome", async (status) => {
    const { child, events } = await running();
    child.notify("item/completed", { ...scope, item: { id: "worker-call", type: "collabAgentToolCall", status: "completed", agentsStates: { synthetic: { status } } } });
    expect(events.at(-1)).toMatchObject({ type: "session.state", nativeState: status });
    expect(events.some((event) => event.type === "worker.status")).toBe(false);
  });

  it("keeps observer event sequences ordered during reentrant interrupt", async () => {
    const { adapter, child, session } = await running();
    const first: NativeHarnessEvent[] = []; const second: NativeHarnessEvent[] = [];
    const interrupts: Promise<unknown>[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => {
      first.push(event);
      if (event.type === "approval.requested") interrupts.push(adapter.interrupt({ type: "session.interrupt", session }));
    });
    adapter.observe({ type: "session.observe", session }, (event) => second.push(event));
    approval(child);
    await Promise.all(interrupts);
    for (const events of [first, second]) expect(events.map((event) => event.sequence)).toEqual(events.map((event) => event.sequence).sort((a, b) => a - b));
    expect(second.filter((event) => event.type.startsWith("approval.")).map((event) => event.type)).toEqual(["approval.requested", "approval.resolved"]);
  });

  it("expires prompts before state observers can dispose and suppresses late prompt delivery", async () => {
    const { adapter, child, session, events } = await running();
    const pending: Promise<unknown>[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => { if (event.type === "session.state" && event.state === "waiting_for_approval") pending.push(adapter.dispose({ type: "session.dispose", session })); });
    approval(child);
    await Promise.all(pending);
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("accepts native interrupted outcome preceding the interrupt RPC response", async () => {
    const { adapter, child, session, events } = await running({ handle: (process, request) => {
      if (request.method !== "turn/interrupt") return false;
      terminal(process, "interrupted"); return true;
    } });
    expect(await adapter.interrupt({ type: "session.interrupt", session })).toMatchObject({ status: "ok" });
    expect(events.at(-1)).toMatchObject({ type: "session.cancelled" });
  });

  it("renders managed-network context and restricts choices to the offered native decisions", async () => {
    const { child, events } = await running();
    approval(child, 5, { networkApprovalContext: { host: "example.invalid", protocol: "https" }, availableDecisions: ["acceptForSession", "decline", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["synthetic"] } }] });
    expect(requestEvent(events)).toMatchObject({ prompt: expect.stringContaining("network access: example.invalid (https)"), choices: ["decline"] });
  });

  it("never accepts a prior adapter instance's approval even when synthetic native IDs repeat", async () => {
    const first = await running(); approval(first.child);
    const oldApproval = requestEvent(first.events);
    await first.adapter.dispose({ type: "session.dispose", session: first.session });
    const second = await running(); approval(second.child);
    const newApproval = requestEvent(second.events);
    expect(newApproval.approvalId).not.toBe(oldApproval.approvalId);
    expect(await second.adapter.respondToApproval(response(second.session, oldApproval))).toMatchObject({ code: "stale_approval" });
    expect(await second.adapter.respondToApproval(response(second.session, newApproval, "decline"))).toMatchObject({ status: "ok" });
  });

  it("cleans up on disposal, rejects reused IDs and supports a fresh separate session", async () => {
    const instance = await running(); const { adapter, child, session, events } = instance;
    approval(child); const pending = requestEvent(events); const count = events.length;
    expect(await adapter.dispose({ type: "session.dispose", session })).toMatchObject({ status: "ok" });
    child.notify("item/agentMessage/delta", { ...scope, itemId: "late", delta: "late" });
    expect(events).toHaveLength(count);
    expect(child.signals).toContain("SIGTERM");
    expect(await adapter.respondToApproval(response(session, pending))).toMatchObject({ code: "invalid_session" });
    expect(await adapter.start(startCommand)).toMatchObject({ code: "duplicate_session" });
    const fresh = await adapter.start({ ...startCommand, sessionId: "fresh" });
    expect(fresh.status).toBe("ok");
    if (fresh.status === "ok") disposals.push(() => adapter.dispose({ type: "session.dispose", session: fresh.value }));
    expect(await adapter.resume({ type: "session.resume", sessionId: "resume", nativeSessionId: threadId, workspace })).toMatchObject({ status: "unsupported" });
  });

  it("rejects concurrent starts and input, preserving only one native thread and turn", async () => {
    const instance = rig(); const { adapter } = instance;
    const starting = adapter.start(startCommand);
    expect(await adapter.start({ ...startCommand, sessionId: "parallel" })).toMatchObject({ code: "invalid_state" });
    const started = await starting; if (started.status !== "ok") throw new Error("start failed");
    disposals.push(() => adapter.dispose({ type: "session.dispose", session: started.value }));
    const command = { type: "session.input" as const, session: started.value, input: "synthetic" };
    const results = await Promise.all([adapter.sendInput(command), adapter.sendInput(command)]);
    expect(results.map((result) => result.status)).toEqual(["ok", "rejected"]);
    expect(instance.child.messages.filter((message) => message.method === "turn/start")).toHaveLength(1);
  });

  it.each(["approvalPolicy", "sandbox", "config", "env", "auth", "threadId"])("rejects %s native overrides before spawning", async (key) => {
    const { adapter, calls } = rig();
    expect(await adapter.start({ ...startCommand, nativeOptions: { [key]: "synthetic" } })).toMatchObject({ status: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("allows only the explicit model option and reports effective native permission reviewer", async () => {
    const { adapter, children } = rig({ started: { thread: { id: threadId }, approvalPolicy: "never", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false } } });
    const started = await adapter.start({ ...startCommand, nativeOptions: { model: "synthetic-model" } });
    expect(started.status).toBe("ok"); if (started.status !== "ok") return;
    disposals.push(() => adapter.dispose({ type: "session.dispose", session: started.value }));
    expect(children[0].messages.at(-1).params).toEqual({ cwd: workspace, model: "synthetic-model" });
    const listener = vi.fn(); adapter.observe({ type: "session.observe", session: started.value }, listener);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ nativeDetails: { permissionContext: expect.objectContaining({ approvalPolicy: "never", approvalsReviewer: "auto_review" }) } }));
  });

  it.each([
    [{ version: "codex-cli 0.999.0" }, "incompatible_codex"],
    [{ initialized: {} }, "incompatible_codex_protocol"],
    [{ auth: { account: null, requiresOpenaiAuth: true } }, "codex_authentication_required"],
    [{ auth: { account: null } }, "incompatible_codex_protocol"],
    [{ auth: { account: {}, requiresOpenaiAuth: true } }, "incompatible_codex_protocol"],
    [{ started: { thread: { id: threadId } } }, "incompatible_codex_protocol"],
  ] as const)("rejects unsupported startup evidence %j", async (options, code) => {
    const { adapter, children } = rig(options);
    expect(await adapter.start(startCommand)).toMatchObject({ status: "error", code });
    expect(children.every((child) => child.signalCode !== null)).toBe(true);
  });

  it("reports missing installation without inspecting credentials", async () => {
    const adapter = new CodexNativeHarnessAdapter({ processFactory: () => { throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" }); } });
    expect(await adapter.start(startCommand)).toMatchObject({ status: "error", code: "codex_not_installed", message: expect.stringContaining("Install Codex") });
  });

  it("handles asynchronous executable failure and disposal during startup", async () => {
    const child = new SyntheticChild();
    const adapter = new CodexNativeHarnessAdapter({ shutdownTimeoutMs: 5, processFactory: () => {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("synthetic missing"), { code: "ENOENT" })));
      return child.asChild();
    } });
    expect(await adapter.start(startCommand)).toMatchObject({ code: "codex_not_installed" });
    expect(child.signals).toContain("SIGTERM");
    const instance = rig();
    const starting = instance.adapter.start(startCommand);
    await instance.adapter.dispose({ type: "session.dispose", session: { adapterId: "codex", sessionId: startCommand.sessionId } });
    expect(await starting).toMatchObject({ status: "error", code: "codex_disconnected" });
    expect(instance.children).toHaveLength(0);
  });

  it("handles native RPC startup errors and missing methods without retries", async () => {
    const { adapter, children } = rig({ handle: (process, request) => {
      if (request.method !== "initialize") return false;
      process.send({ id: request.id, error: { code: -32601, message: "Synthetic unsupported method" } }); return true;
    } });
    expect(await adapter.start(startCommand)).toMatchObject({ code: "incompatible_codex_protocol" });
    expect(children[0].messages).toHaveLength(1);
  });

  it("reports abrupt subprocess exit and expires every pending approval", async () => {
    const { adapter, child, session, events } = await running();
    approval(child); const pending = requestEvent(events);
    child.exit(17);
    expect(events.at(-1)).toMatchObject({ type: "session.error", error: { code: "codex_process_exit", nativeDetails: { exitCode: 17 } } });
    expect(await adapter.respondToApproval(response(session, pending))).toMatchObject({ code: "invalid_state" });
  });

  it("fails uncertain requests on timeout and force-kills a child that ignores SIGTERM", async () => {
    const { adapter, children } = rig({ requestTimeoutMs: 10, ignoreTerm: true, handle: (_child, request) => request.method === "initialize" });
    expect(await adapter.start(startCommand)).toMatchObject({ code: "codex_timeout", message: expect.stringContaining("outcome is unknown") });
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("fails a broken approval write, rejects replay and never claims native resolution", async () => {
    const { adapter, child, session, events } = await running();
    approval(child); const pending = requestEvent(events); child.failWrite = true;
    expect(await adapter.respondToApproval(response(session, pending))).toMatchObject({ status: "error", code: "codex_disconnected" });
    expect(await adapter.respondToApproval(response(session, pending))).toMatchObject({ status: "rejected" });
    expect(events.at(-1)).toMatchObject({ type: "session.error" });
    expect(events.filter((event) => event.type === "approval.resolved")).toEqual([expect.objectContaining({ nativeDetails: expect.objectContaining({ resolution: "session_error" }) })]);
  });

  it("accepts a matching native completion that arrives before the turn/start response", async () => {
    const instance = rig({ handle: (child, request) => {
      if (request.method !== "turn/start") return false;
      child.notify("turn/started", { threadId, turn: turn() }); terminal(child); return true;
    } });
    const started = await instance.adapter.start(startCommand); if (started.status !== "ok") throw new Error("start failed");
    disposals.push(() => instance.adapter.dispose({ type: "session.dispose", session: started.value }));
    expect(await instance.adapter.sendInput({ type: "session.input", session: started.value, input: "synthetic" })).toMatchObject({ status: "ok" });
  });
});

describe("Codex stdio framing", () => {
  function transport(timeoutMs = 1000) {
    const child = new SyntheticChild(); const messages = vi.fn(); const errors = vi.fn();
    const rpc = new CodexRpc(child.asChild(), timeoutMs, 5, messages, errors);
    disposals.push(() => rpc.close());
    return { child, rpc, messages, errors };
  }
  it("handles chunk-split UTF-8, multiple frames, CRLF and numeric response IDs", async () => {
    const { child, rpc, messages } = transport();
    const bytes = Buffer.from(`${JSON.stringify({ method: "synthetic", params: { text: "héllo 🌱" }, id: 4 })}\r\n\n${JSON.stringify({ method: "second", params: {} })}\n`);
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    expect(messages.mock.calls).toEqual([["synthetic", { text: "héllo 🌱" }, 4], ["second", {}, undefined]]);
    const pending = rpc.request("synthetic/request", {});
    child.reply(child.messages.at(-1)!, { accepted: true });
    expect(await pending).toEqual({ accepted: true });
  });
  it.each(["not json\n", "[]\n", "{\"id\":null,\"result\":{}}\n", "{\"id\":\"unknown\",\"result\":{}}\n", "{\"method\":\"test\",\"params\":[]}\n"])("fails malformed frame %j", (frame) => {
    const { child, errors } = transport(); child.stdout.write(frame);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: "codex_malformed_message" }));
    expect(child.signals).toContain("SIGTERM");
  });
  it.each([true, false])("bounds oversized frames, terminated=%s", (terminated) => {
    const { child, errors } = transport(); child.stdout.write("x".repeat(1024 * 1024 + 1) + (terminated ? "\n" : ""));
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ code: "codex_malformed_message" }));
  });
  it("treats truncated EOF as disconnect and rejects in-flight commands", async () => {
    const { child, rpc, errors } = transport(); const pending = rpc.request("pending", {});
    child.stdout.end("{\"incomplete\":");
    await expect(pending).rejects.toMatchObject({ code: "codex_disconnected" });
    expect(errors).toHaveBeenCalledTimes(1);
  });
  it("settles a blocked write immediately when disposed", async () => {
    const { child, rpc } = transport(); child.hangWrite = true;
    const writing = rpc.send({ id: 7, result: { decision: "decline" } });
    const rejection = expect(writing).rejects.toMatchObject({ code: "codex_disconnected" });
    await rpc.close(); await rejection;
  });
  it("bounds approval writes that never flush", async () => {
    const { child, rpc, errors } = transport(10); child.hangWrite = true;
    await expect(rpc.send({ id: 7, result: { decision: "decline" } })).rejects.toMatchObject({ code: "codex_timeout" });
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("real synthetic subprocess boundary", () => {
  it.each(["happy", "exit"])("uses a real credential-free child for %s", async (mode) => {
    const fixture = fileURLToPath(new URL("./fixtures/codex-server.mjs", import.meta.url));
    const children: ChildProcessWithoutNullStreams[] = [];
    const adapter = new CodexNativeHarnessAdapter({ shutdownTimeoutMs: 20, processFactory: (_executable, args) => {
      const child = spawn(process.execPath, [fixture, args[0] === "--version" ? "version" : mode], { stdio: "pipe", env: {} });
      children.push(child); return child;
    } });
    const started = await adapter.start(startCommand); expect(started.status).toBe("ok"); if (started.status !== "ok") return;
    const session = started.value; disposals.push(() => adapter.dispose({ type: "session.dispose", session }));
    const events: NativeHarnessEvent[] = []; adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    await adapter.sendInput({ type: "session.input", session, input: "Synthetic prompt" });
    await vi.waitFor(() => expect(events.some((event) => event.type === (mode === "happy" ? "session.completed" : "session.error"))).toBe(true));
    await adapter.dispose({ type: "session.dispose", session });
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });
});
