import { FakeNativeHarnessAdapter } from "../../../src/harness/fake.js";
import type { NativeHarnessEventListener, ObserveSessionCommand, RespondToApprovalCommand, SendInputCommand } from "../../../src/harness/types.js";

/** Offline UI fixture. Never launches Codex, reads authentication, or executes a command. */
export class SyntheticNativeAdapter extends FakeNativeHarnessAdapter {
  private turns = new Map<string, number>();
  constructor() { super({ adapterId: "synthetic-codex" }); }
  override observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener) {
    const result = super.observe(command, listener);
    if (result.status === "ok") this.emit(command.session, { type: "session.state", state: "ready", nativeDetails: {
      permissionContext: { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspace-write" } },
    } });
    return result;
  }
  override async sendInput(command: SendInputCommand) {
    const result = await super.sendInput(command);
    if (result.status !== "ok") return result;
    const turn = (this.turns.get(command.session.sessionId) ?? 0) + 1;
    this.turns.set(command.session.sessionId, turn);
    this.emit(command.session, { type: "conversation.delta", role: "assistant", nativeMessageId: "answer", text: "Reviewing the " });
    this.emit(command.session, { type: "conversation.delta", role: "assistant", nativeMessageId: "answer", text: "synthetic example." });
    this.emit(command.session, { type: "conversation.message", role: "assistant", nativeMessageId: "answer", text: `Reviewing the synthetic example. Turn ${turn}.\n${Array.from({ length: 18 }, (_, i) => `Evidence line ${i + 1}: local fixture output.`).join("\n")}` });
    this.emit(command.session, { type: "worker.status", workerId: "observed-helper", label: "Synthetic observed helper", state: "running", nativeState: "running", nativeDetails: { origin: "native observation fixture" } });
    this.emit(command.session, { type: "tool.activity", toolCallId: "command", name: "commandExecution", state: "started", input: "pnpm test --offline", nativeDetails: { params: { item: { cwd: "/synthetic/workspace" } } } });
    this.emit(command.session, { type: "change.reported", changeId: "patch", files: [{ path: "example.ts", kind: "modified" }], nativeDetails: { params: { diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const answer = 1;\n+const answer = 2;" } } });
    this.emit(command.session, { type: "approval.requested", approvalId: `prompt-${turn}`, nativeApprovalId: String(turn), prompt: "Allow the synthetic test command in this workspace?", choices: ["accept", "decline", "cancel"], nativeDetails: { params: { itemId: "command", command: "pnpm test --offline", cwd: "/synthetic/workspace" } } }, `request-${turn}`);
    return result;
  }
  override async respondToApproval(command: RespondToApprovalCommand) {
    const result = await super.respondToApproval(command);
    if (result.status !== "ok") return result;
    const turn = this.turns.get(command.session.sessionId)!;
    this.emit(command.session, { type: "tool.activity", toolCallId: "command", name: "commandExecution", state: "completed", output: "Synthetic checks passed; no process executed." });
    this.emit(command.session, { type: "worker.status", workerId: "observed-helper", label: "Synthetic observed helper", state: "completed" });
    this.emit(command.session, { type: "turn.completed", nativeTurnId: `native-${command.session.sessionId}:turn-${turn}`, outcome: "completed" });
    return result;
  }
}
