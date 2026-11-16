import type { NativeHarnessEvent, NativeHarnessTurnIdentity } from "../../../src/harness/types.js";

/** Synthetic shared-UI fixtures: provider turn identity and native permission shape differ. */
export function providerEvents(adapterId: "codex" | "claude"): NativeHarnessEvent[] {
  const identity = { adapterId, sessionId: `local-${adapterId}`, nativeSessionId: `synthetic-${adapterId}` };
  const turn: NativeHarnessTurnIdentity = adapterId === "codex" ? { nativeTurnId: "codex-native-turn" } : { turnId: "ace-input-uuid" };
  const permissionContext = adapterId === "codex" ? { approvalPolicy: "on-request", sandbox: { type: "readOnly" } }
    : { permissionMode: "default", rulesMayResolveBeforeCallback: true };
  const base = { ...identity, timestamp: "2026-01-01T00:00:00.000Z" };
  return [
    { ...base, sequence: 1, type: "session.state", state: "ready", nativeDetails: { permissionContext } },
    { ...base, ...turn, sequence: 2, type: "turn.started" },
    { ...base, ...turn, sequence: 3, type: "conversation.delta", role: "assistant", text: "Synthetic response", nativeMessageId: "message-one" },
    { ...base, ...turn, sequence: 4, type: "turn.completed", outcome: "completed" },
    { ...base, sequence: 5, type: "session.state", state: "ready", nativeDetails: { permissionContext } },
  ];
}
