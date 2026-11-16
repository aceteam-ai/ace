import { describe, expect, it } from "vitest";
import type { NativeHarnessEvent, NativeHarnessEventPayload } from "../../src/harness/types.js";
import { initialNativeSessionState, nativePermissionSummary, nativeText, reduceNativeEvent, type NativeSessionState } from "../../src/ui/native-session-state.js";

const identity = { adapterId: "codex", sessionId: "local", nativeSessionId: "native" };
const initial = (): NativeSessionState => ({ ...initialNativeSessionState(), identity, phase: "ready" });
const event = (sequence: number, payload: NativeHarnessEventPayload): NativeHarnessEvent => ({ ...identity, timestamp: "2026-01-01T00:00:00Z", sequence, nativeTurnId: "turn-1", ...payload });

describe("native presentation state", () => {
  it("deduplicates final messages after deltas and isolates repeated item IDs by turn", () => {
    let state = initial();
    const message = { role: "assistant", nativeMessageId: "same" } as const;
    state = reduceNativeEvent(state, event(1, { type: "conversation.delta", ...message, text: "Hel" }));
    state = reduceNativeEvent(state, event(2, { type: "conversation.delta", ...message, text: "lo" }));
    state = reduceNativeEvent(state, event(3, { type: "conversation.message", ...message, text: "Hello." }));
    state = reduceNativeEvent(state, event(4, { type: "conversation.delta", ...message, text: "late" }));
    state = reduceNativeEvent(state, { ...event(5, { type: "conversation.message", ...message, text: "Next" }), nativeTurnId: "turn-2" });
    expect(state.messages.map((item) => item.text)).toEqual(["Hello.", "Next"]);
  });

  it("ignores foreign identities, duplicate/out-of-order events and events after local closure", () => {
    const start = initial();
    const next = event(1, { type: "session.state", state: "running" });
    for (const identityPart of [{ adapterId: "other" }, { sessionId: "other" }, { nativeSessionId: "other" }]) {
      expect(reduceNativeEvent(start, { ...next, ...identityPart })).toBe(start);
    }
    const running = reduceNativeEvent(start, next);
    expect(reduceNativeEvent(running, next)).toBe(running);
    const closed = reduceNativeEvent(running, event(2, { type: "session.cancelled" }));
    expect(reduceNativeEvent(closed, event(3, { type: "session.state", state: "ready" }))).toBe(closed);
  });

  it("retains reported permissions, observed activity, real patches and explicit missing patches", () => {
    let state = reduceNativeEvent(initial(), event(1, { type: "session.state", state: "ready", nativeDetails: { permissionContext: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspace-write" } } } }));
    expect(nativePermissionSummary(state)).toBe("Approval: on-request | Reviewer: user | Sandbox: workspace-write");
    expect(nativePermissionSummary({ ...state, permissionContext: { approvalPolicy: { reject: { sandbox_approval: true } } } })).not.toContain("\n");
    state = reduceNativeEvent(state, event(2, { type: "tool.activity", toolCallId: "tool", name: "commandExecution", state: "started", input: "pnpm test" }));
    state = reduceNativeEvent(state, event(3, { type: "worker.status", workerId: "worker", state: "running", nativeState: "native-busy", label: "Observed helper" }));
    state = reduceNativeEvent(state, event(4, { type: "change.reported", changeId: "patch", files: [{ path: "example.ts", kind: "modified" }], nativeDetails: { params: { item: { changes: [{ diff: "-before\n+after" }] } } } }));
    state = reduceNativeEvent(state, event(5, { type: "change.reported", changeId: "summary", files: [{ path: "other.ts", kind: "added" }] }));
    expect(state.tools[0].details).toContain("pnpm test");
    expect(state.workers[0].state).toBe("native-busy");
    expect(state.changes.map((item) => item.patch)).toEqual(["-before\n+after", undefined]);
  });

  it("keeps request correlation exact and expires turn approvals before ready", () => {
    let state = reduceNativeEvent(initial(), { ...event(1, { type: "approval.requested", approvalId: "request", nativeApprovalId: "17", prompt: "Review", choices: ["accept", "decline"] }), correlationId: "exact" });
    expect(state.approvals[0]).toMatchObject({ correlationId: "exact", nativeApprovalId: "17", turnId: "turn-1", status: "waiting" });
    state = reduceNativeEvent(state, event(2, { type: "turn.completed", nativeTurnId: "turn-1", outcome: "failed", error: { code: "native", message: "Failed", retryable: true } }));
    expect(state.approvals).toEqual([]);
    expect(state.phase).toBe("waiting_for_approval"); // Only the native ready event permits follow-up input.
    expect(state.notice).toBe("Failed");
    state = reduceNativeEvent(state, event(3, { type: "session.state", state: "ready" }));
    expect(state.phase).toBe("ready");
  });

  it("bounds display history and strips ANSI, OSC, carriage returns and C1 controls", () => {
    expect(nativeText("safe\u001b[2J\u001b]8;;https://invalid.example\u0007link\u001b]8;;\u0007\r\u0085\u009b")).toBe("safelink");
    expect(nativeText("x".repeat(50_000))).toHaveLength(40_020);
    let state = initial();
    for (let i = 1; i <= 220; i++) state = reduceNativeEvent(state, event(i, { type: "conversation.message", role: "assistant", text: String(i) }));
    expect(state.messages).toHaveLength(200);
    expect(state.messages[0].text).toBe("21");
  });
});

it.each(["codex", "claude"] as const)("renders shared %s fixtures with honest provider turn IDs and native permissions", async (provider) => {
  const { providerEvents } = await import("../harness/fixtures/provider-events.js");
  const events = providerEvents(provider);
  let state: NativeSessionState = { ...initialNativeSessionState(), phase: "ready", identity: { adapterId: provider, sessionId: `local-${provider}` } };
  for (const next of events.slice(0, 3)) state = reduceNativeEvent(state, next);
  expect(state.identity?.nativeSessionId).toBe(`synthetic-${provider}`);
  expect(state.nativeTurnId).toBe(provider === "codex" ? "codex-native-turn" : undefined);
  expect(state.turnId).toBe(provider === "claude" ? "ace-input-uuid" : undefined);
  expect(nativePermissionSummary(state)).toContain(provider === "codex" ? "Approval: on-request" : "Claude mode: default");
  if (provider === "claude") expect(nativePermissionSummary(state)).not.toContain("Sandbox:");
  for (const next of events.slice(3)) state = reduceNativeEvent(state, next);
  expect(state.phase).toBe("ready"); expect(state.messages[0].text).toBe("Synthetic response");
});

it("associates local turn approvals and native structured patches without a made-up native turn ID", () => {
  let state: NativeSessionState = { ...initialNativeSessionState(), phase: "ready", identity: { adapterId: "claude", sessionId: "local" } };
  const base = { adapterId: "claude", sessionId: "local", turnId: "local-turn", timestamp: "2026-01-01T00:00:00Z" };
  state = reduceNativeEvent(state, { ...base, sequence: 1, type: "turn.started" });
  state = reduceNativeEvent(state, { ...base, sequence: 2, type: "approval.requested", approvalId: "request", prompt: "Edit?", choices: ["allow_once", "deny"], nativeDetails: { toolName: "Edit", input: { file_path: "example.ts" }, reason: "Native rule" } });
  expect(state.approvals[0]).toMatchObject({ turnId: "local-turn" });
  expect(state.approvals[0].details).toContain("file_path");
  state = reduceNativeEvent(state, { ...base, sequence: 3, type: "change.reported", changeId: "edit", files: [{ path: "example.ts", kind: "modified" }], nativeDetails: { structuredPatch: [{ oldStart: 1, lines: ["-before", "+after"] }] } });
  expect(state.changes[0].patch).toContain("+after");
  state = reduceNativeEvent(state, { ...base, sequence: 4, type: "turn.completed", outcome: "completed" });
  expect(state.approvals).toEqual([]); expect(state.phase).toBe("waiting_for_approval");
});
