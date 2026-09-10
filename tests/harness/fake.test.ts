import { describe, expect, it, vi } from "vitest";
import {
  FakeNativeHarnessAdapter,
  type NativeHarnessEvent,
  type NativeHarnessSessionIdentity,
} from "../../src/harness/index.js";

async function startSession(
  adapter: FakeNativeHarnessAdapter,
  sessionId: string
): Promise<NativeHarnessSessionIdentity> {
  const result = await adapter.start({
    type: "session.start",
    sessionId,
    workspace: "/synthetic/workspace",
  });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") {
    throw new Error("Expected fake session to start.");
  }
  return result.value;
}

describe("FakeNativeHarnessAdapter", () => {
  it("streams every event family with stable identity and native detail", async () => {
    const adapter = new FakeNativeHarnessAdapter({
      adapterId: "synthetic-adapter",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const session = await startSession(adapter, "session-a");
    const events: NativeHarnessEvent[] = [];
    const observation = adapter.observe(
      { type: "session.observe", session },
      (event) => events.push(event)
    );
    expect(observation.status).toBe("ok");

    const payloads = [
      { type: "session.state", state: "running", nativeState: "busy" },
      {
        type: "conversation.delta",
        role: "assistant",
        text: "Hel",
        nativeMessageId: "message-1",
      },
      {
        type: "conversation.message",
        role: "assistant",
        text: "Hello",
        nativeMessageId: "message-1",
      },
      {
        type: "worker.status",
        workerId: "worker-1",
        state: "running",
        nativeWorkerId: "native-worker-1",
      },
      {
        type: "tool.activity",
        toolCallId: "tool-1",
        name: "read_file",
        state: "completed",
        nativeToolCallId: "native-tool-1",
      },
      {
        type: "change.reported",
        changeId: "change-1",
        files: [{ path: "src/example.ts", kind: "modified" }],
        nativeChangeId: "native-change-1",
      },
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Allow this synthetic action?",
        choices: ["allow", "deny"],
        nativeApprovalId: "native-approval-1",
      },
      { type: "session.completed", result: { text: "done" } },
    ] as const;

    for (const payload of payloads) {
      const result = adapter.emit(session, payload, "turn-1");
      expect(result.status).toBe("ok");
    }

    expect(events.map((event) => event.type)).toEqual(
      payloads.map((payload) => payload.type)
    );
    expect(events[0]).toMatchObject({
      adapterId: "synthetic-adapter",
      sessionId: "session-a",
      nativeSessionId: "native-session-a",
      correlationId: "turn-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      nativeState: "busy",
    });
    expect(events[4]).toMatchObject({
      nativeToolCallId: "native-tool-1",
    });
    expect(events[5]).toMatchObject({
      nativeChangeId: "native-change-1",
    });
  });

  it("emits user input and completes without subprocess or network work", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    const listener = vi.fn();
    adapter.observe({ type: "session.observe", session }, listener);

    const input = await adapter.sendInput({
      type: "session.input",
      session,
      input: "Synthetic prompt",
      correlationId: "turn-1",
    });
    const delta = adapter.emit(
      session,
      { type: "conversation.delta", role: "assistant", text: "Synthetic reply" },
      "turn-1"
    );
    const completion = adapter.emit(
      session,
      { type: "session.completed", result: "done" },
      "turn-1"
    );

    expect(input).toEqual({ status: "ok", value: { accepted: true } });
    expect(delta.status).toBe("ok");
    expect(completion.status).toBe("ok");
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      "turn.started",
      "session.state",
      "conversation.message",
      "conversation.delta",
      "session.completed",
    ]);
  });

  it("reports cancellation as terminal and rejects later input", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    const events: NativeHarnessEvent[] = [];
    adapter.observe(
      { type: "session.observe", session },
      (event) => events.push(event)
    );

    const interrupt = adapter.emit(session, {
      type: "session.cancelled", reason: "User cancelled",
    }, "turn-1");
    const input = await adapter.sendInput({
      type: "session.input",
      session,
      input: "Too late",
    });

    expect(interrupt.status).toBe("ok");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "session.cancelled",
      reason: "User cancelled",
      correlationId: "turn-1",
    });
    expect(input).toMatchObject({
      status: "rejected",
      code: "invalid_state",
    });
  });

  it("keeps adapter failures distinct from successful command results", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    adapter.failNext("sendInput", {
      code: "synthetic_failure",
      message: "Synthetic adapter failure",
      nativeDetails: { providerCode: "E_SYNTHETIC" },
    });

    const result = await adapter.sendInput({
      type: "session.input",
      session,
      input: "Trigger failure",
    });

    expect(result).toEqual({
      status: "error",
      code: "synthetic_failure",
      message: "Synthetic adapter failure",
      nativeDetails: { providerCode: "E_SYNTHETIC" },
    });
  });

  it("emits diagnostic errors with native detail and makes them terminal", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    const listener = vi.fn();
    adapter.observe({ type: "session.observe", session }, listener);

    const emitted = adapter.emit(session, {
      type: "session.error",
      error: {
        code: "synthetic_native_error",
        message: "Synthetic failure",
        retryable: false,
        nativeDetails: { nativeCode: 17 },
      },
      nativeState: "failed",
    });
    const later = adapter.emit(session, {
      type: "conversation.delta",
      role: "assistant",
      text: "must not emit",
    });

    expect(emitted.status).toBe("ok");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      type: "session.error",
      error: {
        nativeDetails: { nativeCode: 17 },
      },
    });
    expect(later).toMatchObject({ status: "rejected", code: "invalid_state" });
  });

  it("becomes terminal before completion observers can send more input", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    let nestedInput: ReturnType<FakeNativeHarnessAdapter["sendInput"]> | undefined;
    adapter.observe({ type: "session.observe", session }, (event) => {
      if (event.type === "session.completed") {
        nestedInput = adapter.sendInput({
          type: "session.input",
          session,
          input: "Too late",
        });
      }
    });

    adapter.emit(session, { type: "session.completed", result: "done" });

    await expect(nestedInput).resolves.toMatchObject({
      status: "rejected",
      code: "invalid_state",
    });
  });

  it("accepts one matching approval reply and rejects duplicate or stale replies", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    adapter.emit(
      session,
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Proceed?",
        choices: ["allow", "deny"],
      },
      "request-1"
    );

    const mismatched = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-2",
    });
    const accepted = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });
    const duplicate = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });

    expect(mismatched).toMatchObject({
      status: "rejected",
      code: "approval_mismatch",
    });
    expect(accepted.status).toBe("ok");
    expect(duplicate).toMatchObject({
      status: "rejected",
      code: "stale_approval",
    });
  });

  it("expires a pending request when the native approval resolves", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    adapter.emit(
      session,
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Proceed?",
        choices: ["allow", "deny"],
      },
      "request-1"
    );
    adapter.emit(
      session,
      {
        type: "approval.resolved",
        approvalId: "approval-1",
        decision: "deny",
      },
      "request-1"
    );

    const reply = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });

    expect(reply).toMatchObject({
      status: "rejected",
      code: "stale_approval",
    });
  });

  it("rejects an unoffered decision without consuming the request", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    adapter.emit(
      session,
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Proceed?",
        choices: ["allow", "deny"],
      },
      "request-1"
    );

    const unoffered = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow-for-session",
      correlationId: "request-1",
    });
    const offered = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });

    expect(unoffered).toMatchObject({
      status: "rejected",
      code: "invalid_approval_decision",
    });
    expect(offered.status).toBe("ok");
  });

  it("does not allow approval responses to cross session boundaries", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const first = await startSession(adapter, "session-a");
    const second = await startSession(adapter, "session-b");
    adapter.emit(
      first,
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Proceed?",
        choices: ["allow", "deny"],
      },
      "request-1"
    );

    const crossSession = await adapter.respondToApproval({
      type: "approval.respond",
      session: second,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });
    const original = await adapter.respondToApproval({
      type: "approval.respond",
      session: first,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });

    expect(crossSession).toMatchObject({
      status: "rejected",
      code: "stale_approval",
    });
    expect(original.status).toBe("ok");
  });

  it("clears observers and approvals when a session is disposed", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    const listener = vi.fn();
    adapter.observe({ type: "session.observe", session }, listener);
    adapter.emit(
      session,
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Proceed?",
        choices: ["allow", "deny"],
      },
      "request-1"
    );

    const disposed = await adapter.dispose({
      type: "session.dispose",
      session,
    });
    const reply = await adapter.respondToApproval({
      type: "approval.respond",
      session,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });
    const emitted = adapter.emit(session, {
      type: "conversation.delta",
      role: "assistant",
      text: "must not emit",
    });

    expect(disposed).toEqual({ status: "ok", value: { disposed: true } });
    expect(reply).toMatchObject({ status: "rejected", code: "invalid_session" });
    expect(emitted).toMatchObject({ status: "rejected", code: "invalid_session" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a disposed local session identity", async () => {
    const adapter = new FakeNativeHarnessAdapter({
      capabilities: { resume: { supported: true } },
    });
    const original = await startSession(adapter, "session-a");
    const nativeSessionId = original.nativeSessionId;
    if (!nativeSessionId) {
      throw new Error("Expected fake session to have a native identity.");
    }
    await adapter.dispose({ type: "session.dispose", session: original });

    const restarted = await adapter.start({
      type: "session.start",
      sessionId: "session-a",
      workspace: "/synthetic/workspace",
    });
    const resumed = await adapter.resume({
      type: "session.resume",
      sessionId: "session-a",
      nativeSessionId,
      workspace: "/synthetic/workspace",
    });

    expect(restarted).toMatchObject({
      status: "rejected",
      code: "duplicate_session",
    });
    expect(resumed).toMatchObject({
      status: "rejected",
      code: "duplicate_session",
    });
  });

  it("does not carry pending approvals into a supported resume", async () => {
    const adapter = new FakeNativeHarnessAdapter({
      capabilities: { resume: { supported: true } },
    });
    const original = await startSession(adapter, "session-a");
    const nativeSessionId = original.nativeSessionId;
    if (!nativeSessionId) {
      throw new Error("Expected fake session to have a native identity.");
    }
    adapter.emit(
      original,
      {
        type: "approval.requested",
        approvalId: "approval-1",
        prompt: "Proceed?",
        choices: ["allow", "deny"],
      },
      "request-1"
    );
    await adapter.dispose({ type: "session.dispose", session: original });
    const resumed = await adapter.resume({
      type: "session.resume",
      sessionId: "session-b",
      nativeSessionId,
      workspace: "/synthetic/workspace",
    });
    expect(resumed.status).toBe("ok");
    if (resumed.status !== "ok") {
      throw new Error("Expected fake session to resume.");
    }

    const reply = await adapter.respondToApproval({
      type: "approval.respond",
      session: resumed.value,
      approvalId: "approval-1",
      decision: "allow",
      correlationId: "request-1",
    });

    expect(reply).toMatchObject({
      status: "rejected",
      code: "stale_approval",
    });
  });

  it("supports disposing an individual observation without ending the session", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    const session = await startSession(adapter, "session-a");
    const listener = vi.fn();
    const observation = adapter.observe(
      { type: "session.observe", session },
      listener
    );
    expect(observation.status).toBe("ok");
    if (observation.status !== "ok") {
      throw new Error("Expected observation to start.");
    }

    observation.value.dispose();
    observation.value.dispose();
    const emitted = adapter.emit(session, {
      type: "conversation.delta",
      role: "assistant",
      text: "No observer",
    });

    expect(emitted.status).toBe("ok");
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a typed unsupported result for unsupported operations", async () => {
    const adapter = new FakeNativeHarnessAdapter({
      capabilities: {
        interrupt: {
          supported: false,
          reason: "Synthetic adapter cannot interrupt.",
        },
      },
    });
    const session = await startSession(adapter, "session-a");

    const result = await adapter.interrupt({
      type: "session.interrupt",
      session,
    });

    expect(adapter.capabilities.interrupt).toEqual({
      supported: false,
      reason: "Synthetic adapter cannot interrupt.",
    });
    expect(result).toEqual({
      status: "unsupported",
      operation: "interrupt",
      reason: "Synthetic adapter cannot interrupt.",
    });
  });

  it("reports resume as unsupported by default", async () => {
    const adapter = new FakeNativeHarnessAdapter();

    const result = await adapter.resume({
      type: "session.resume",
      sessionId: "session-a",
      nativeSessionId: "native-existing",
      workspace: "/synthetic/workspace",
    });

    expect(result).toEqual({
      status: "unsupported",
      operation: "resume",
      reason: "This adapter does not support session resume.",
    });
  });

  it("preserves the requested native identity when resume is supported", async () => {
    const adapter = new FakeNativeHarnessAdapter({
      capabilities: { resume: { supported: true } },
    });
    const original = await startSession(adapter, "session-original");
    await adapter.dispose({ type: "session.dispose", session: original });

    const result = await adapter.resume({
      type: "session.resume",
      sessionId: "session-a",
      nativeSessionId: "native-session-original",
      workspace: "/synthetic/workspace",
    });

    expect(result).toEqual({
      status: "ok",
      value: {
        adapterId: "fake",
        sessionId: "session-a",
        nativeSessionId: "native-session-original",
      },
    });
  });

  it("does not treat an unknown native session as resumable", async () => {
    const adapter = new FakeNativeHarnessAdapter({
      capabilities: { resume: { supported: true } },
    });

    const result = await adapter.resume({
      type: "session.resume",
      sessionId: "session-a",
      nativeSessionId: "native-not-created-here",
      workspace: "/synthetic/workspace",
    });

    expect(result).toMatchObject({
      status: "rejected",
      code: "invalid_session",
    });
  });
  it.each(["completed", "interrupted", "failed"] as const)("returns ready after a fake %s turn and accepts a second turn", async (outcome) => {
    const adapter = new FakeNativeHarnessAdapter(); const session = await startSession(adapter, "multi-turn");
    const events: NativeHarnessEvent[] = []; adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    await adapter.sendInput({ type: "session.input", session, input: "First" });
    const first = events.find((event) => event.type === "turn.started")!;
    expect(await adapter.sendInput({ type: "session.input", session, input: "Busy" })).toMatchObject({ code: "invalid_state" });
    expect(adapter.emit(session, { type: "turn.completed", nativeTurnId: first.nativeTurnId!, outcome })).toMatchObject({ status: "ok" });
    expect(events.at(-1)).toMatchObject({ type: "session.state", state: "ready" });
    expect(await adapter.sendInput({ type: "session.input", session, input: "Second" })).toMatchObject({ status: "ok" });
    expect(events.filter((event) => event.type === "turn.started").map((event) => event.nativeTurnId)).toEqual(["native-multi-turn:turn-1", "native-multi-turn:turn-2"]);
  });

  it("interrupts the active fake turn without terminating the session", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const session = await startSession(adapter, "interrupt-turn");
    const listener = vi.fn(); adapter.observe({ type: "session.observe", session }, listener);
    expect(await adapter.interrupt({ type: "session.interrupt", session })).toMatchObject({ code: "invalid_state" });
    await adapter.sendInput({ type: "session.input", session, input: "First" });
    expect(await adapter.interrupt({ type: "session.interrupt", session })).toMatchObject({ status: "ok" });
    expect(listener.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ type: "turn.completed", outcome: "interrupted" }));
    expect(await adapter.sendInput({ type: "session.input", session, input: "Second" })).toMatchObject({ status: "ok" });
  });

  it("expires fake turn approvals before completion callbacks and rejects reused IDs", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const session = await startSession(adapter, "approvals");
    const events: NativeHarnessEvent[] = []; adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    await adapter.sendInput({ type: "session.input", session, input: "First" });
    const id = events[0].nativeTurnId!;
    const payload = { type: "approval.requested" as const, approvalId: "request-one", prompt: "Synthetic approval", choices: ["allow", "deny"] };
    adapter.emit(session, payload, "correlation-one");
    const reply = { type: "approval.respond" as const, session, approvalId: payload.approvalId, correlationId: "correlation-one", decision: "allow" };
    const results: Promise<unknown>[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => { if (event.type === "turn.completed") results.push(adapter.respondToApproval(reply), adapter.sendInput({ type: "session.input", session, input: "Too early" })); });
    adapter.emit(session, { type: "turn.completed", nativeTurnId: id, outcome: "completed" });
    expect(await Promise.all(results)).toEqual([expect.objectContaining({ code: "stale_approval" }), expect.objectContaining({ code: "invalid_state" })]);
    await adapter.sendInput({ type: "session.input", session, input: "Second" });
    expect(adapter.emit(session, payload, "correlation-one")).toMatchObject({ code: "stale_approval" });
    expect(adapter.emit(session, { type: "turn.completed", nativeTurnId: id, outcome: "completed" })).toMatchObject({ code: "invalid_state" });
  });

  it("handles throwing/reentrant fake observers without leaving the turn stuck or corrupting order", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const session = await startSession(adapter, "observers");
    const events: NativeHarnessEvent[] = []; const followups: Promise<unknown>[] = [];
    adapter.observe({ type: "session.observe", session }, () => { throw new Error("Synthetic renderer failure"); });
    adapter.observe({ type: "session.observe", session }, (event) => {
      if (event.type === "session.state" && event.state === "ready") followups.push(adapter.sendInput({ type: "session.input", session, input: "Second" }));
    });
    adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    await adapter.sendInput({ type: "session.input", session, input: "First" });
    adapter.emit(session, { type: "turn.completed", nativeTurnId: events[0].nativeTurnId!, outcome: "completed" });
    expect(await Promise.all(followups)).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(events.map((event) => event.sequence)).toEqual(events.map((event) => event.sequence).sort((a, b) => a - b));
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(2);
  });

  it("keeps direct terminal fake events terminal even during turn completion", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const session = await startSession(adapter, "terminal-reentry");
    const events: NativeHarnessEvent[] = []; adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    await adapter.sendInput({ type: "session.input", session, input: "First" });
    adapter.emit(session, { type: "approval.requested", approvalId: "pending", prompt: "Synthetic", choices: ["allow"] });
    adapter.observe({ type: "session.observe", session }, (event) => { if (event.type === "approval.resolved") adapter.emit(session, { type: "session.cancelled" }); });
    adapter.emit(session, { type: "turn.completed", nativeTurnId: events[0].nativeTurnId!, outcome: "completed" });
    expect(events.at(-1)).toMatchObject({ type: "session.cancelled" });
    expect(adapter.emit(session, { type: "session.state", state: "ready" })).toMatchObject({ code: "invalid_state" });
    expect(await adapter.sendInput({ type: "session.input", session, input: "Too late" })).toMatchObject({ code: "invalid_state" });
  });

  it("does not attach old fake input to a reentrant follow-up turn", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const session = await startSession(adapter, "input-reentry");
    const events: NativeHarnessEvent[] = []; const pending: Promise<unknown>[] = [];
    adapter.observe({ type: "session.observe", session }, (event) => {
      if (event.type === "session.state" && event.state === "running" && event.nativeTurnId?.endsWith("turn-1")) adapter.emit(session, { type: "turn.completed", nativeTurnId: event.nativeTurnId, outcome: "completed" });
      if (event.type === "session.state" && event.state === "ready") pending.push(adapter.sendInput({ type: "session.input", session, input: "New input" }));
    });
    adapter.observe({ type: "session.observe", session }, (event) => events.push(event));
    await adapter.sendInput({ type: "session.input", session, input: "Old input" }); await Promise.all(pending);
    expect(events.filter((event) => event.type === "conversation.message")).toEqual([expect.objectContaining({ text: "New input", nativeTurnId: "native-input-reentry:turn-2" })]);
  });

});
