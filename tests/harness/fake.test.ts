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

    const interrupt = await adapter.interrupt({
      type: "session.interrupt",
      session,
      reason: "User cancelled",
      correlationId: "turn-1",
    });
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
});
