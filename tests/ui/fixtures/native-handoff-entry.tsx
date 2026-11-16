import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { startInteractive } from "../../../src/commands/interactive.js";
import { FakeNativeHarnessAdapter } from "../../../src/harness/fake.js";
import { NativeSessionManager, type NativeSessionFactoryHooks } from "../../../src/harness/session-manager.js";
import { NativeSessionStore } from "../../../src/harness/session-store.js";
import type { DisposeSessionCommand, InterruptSessionCommand, NativeHarnessEventListener, NativeHarnessSessionIdentity, ObserveSessionCommand, RespondToApprovalCommand, ResumeSessionCommand, SendInputCommand, StartSessionCommand } from "../../../src/harness/types.js";
import { createNativeSessionsPanel } from "../../../src/ui/NativeSessionsPanel.js";
import type { WorkspaceTaskService } from "../../../src/ui/task-service.js";

// Offline PTY entry: synthetic arguments only. No SDK, authentication, native process, or artifact I/O.
const [workspace, directory, tracePath] = process.argv.slice(2);
if (![workspace, directory, tracePath].every((value) => value && isAbsolute(value))) throw new Error("Pass absolute synthetic workspace, state directory, and trace paths.");
const trace = (method: string, value: unknown) => appendFileSync(tracePath, `${JSON.stringify({ method, value })}\n`, { mode: 0o600 });
class HandoffFixtureAdapter extends FakeNativeHarnessAdapter {
  private actual?: NativeHarnessSessionIdentity;
  private bound = false;
  private seeded = false;
  private turns = 0;
  constructor(adapterId: "codex" | "claude", private readonly hooks: NativeSessionFactoryHooks) {
    super({ adapterId, turnIdentity: adapterId === "claude" ? "local" : "native", nativeSessionId: () => `synthetic-${adapterId}-history`,
      capabilities: { resume: { supported: true }, ...(adapterId === "claude" ? { interrupt: { supported: false as const, reason: "Synthetic fixture: interruption is disabled to demonstrate capability feedback." } } : {}) } });
  }
  private async seed() {
    if (this.seeded) return;
    const history = await super.start({ type: "session.start", sessionId: "synthetic-history-setup", workspace });
    if (history.status !== "ok") throw new Error("Synthetic history seed failed.");
    await super.dispose({ type: "session.dispose", session: history.value });
    this.seeded = true; // Seeding is independent of Ace records and excluded from the product trace.
  }
  override async start(command: StartSessionCommand) {
    await this.seed(); trace("start", { adapterId: this.adapterId, ...command });
    const result = await super.start(command); if (result.status !== "ok") return result;
    this.actual = result.value; this.bound = this.adapterId !== "claude"; this.turns = 0;
    return { status: "ok" as const, value: this.bound ? result.value : { adapterId: this.adapterId, sessionId: command.sessionId } };
  }
  override async resume(command: ResumeSessionCommand) {
    await this.seed(); trace("resume", { adapterId: this.adapterId, ...command });
    const result = await super.resume(command);
    if (result.status === "ok") { this.actual = result.value; this.bound = true; this.turns = 0; }
    return result;
  }
  private permissions() {
    return this.adapterId === "claude" ? { permissionMode: "default", rulesMayResolveBeforeCallback: true }
      : { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspace-write" } };
  }
  override observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener) {
    const result = super.observe({ ...command, session: this.actual! }, (event) => listener({ ...event, nativeSessionId: this.bound ? event.nativeSessionId : undefined }));
    if (result.status === "ok") this.emit(this.actual!, { type: "session.state", state: "ready", nativeDetails: this.bound ? { permissionContext: this.permissions() } : undefined });
    return result;
  }
  override async sendInput(command: SendInputCommand) {
    trace("input", command);
    if (!this.bound) { await this.hooks.onNativeSessionConfirmed(this.actual!); this.bound = true;
      this.emit(this.actual!, { type: "session.state", state: "running", nativeDetails: { permissionContext: this.permissions() } }); }
    const result = await super.sendInput({ ...command, session: this.actual! }); if (result.status !== "ok") return result;
    ++this.turns;
    this.emit(this.actual!, { type: "conversation.message", role: "assistant", nativeMessageId: `answer-${this.turns}`, text: "Synthetic handoff received. No model was called." });
    this.emit(this.actual!, { type: "tool.activity", toolCallId: "edit", name: "Edit", state: "started", input: { file_path: "example.ts" } });
    this.emit(this.actual!, { type: "change.reported", changeId: "example-patch", files: [{ path: "example.ts", kind: "modified" }], nativeDetails: this.adapterId === "claude"
      ? { structuredPatch: [{ oldStart: 1, lines: ["-before", "+after"] }] } : { params: { diff: "-before\n+after" } } });
    this.emit(this.actual!, { type: "approval.requested", approvalId: `request-${this.turns}`, nativeApprovalId: `native-${this.turns}`,
      prompt: "Allow this synthetic edit? No file is changed.", choices: this.adapterId === "claude" ? ["allow_once", "deny"] : ["accept", "decline"],
      nativeDetails: this.adapterId === "claude" ? { toolName: "Edit", input: { file_path: "example.ts" }, reason: "Synthetic native callback" }
        : { params: { command: "synthetic edit", cwd: workspace } } }, `correlation-${this.turns}`);
    return result;
  }
  override async respondToApproval(command: RespondToApprovalCommand) {
    trace("approval", command); const result = await super.respondToApproval({ ...command, session: this.actual! });
    if (result.status === "ok") this.emit(this.actual!, { type: "turn.completed", outcome: "completed", ...(this.adapterId === "claude"
      ? { turnId: `${this.actual!.sessionId}:turn-${this.turns}` } : { nativeTurnId: `${this.actual!.nativeSessionId}:turn-${this.turns}` }) });
    return result;
  }
  override interrupt(command: InterruptSessionCommand) { trace("interrupt", command); return super.interrupt({ ...command, session: this.actual! }); }
  override dispose(command: DisposeSessionCommand) { trace("dispose", command); return super.dispose({ ...command, session: this.actual ?? command.session }); }
}
const manager = new NativeSessionManager({ store: new NativeSessionStore({ directory }), adapters: {
  codex: (_store, hooks) => new HandoffFixtureAdapter("codex", hooks), claude: (_store, hooks) => new HandoffFixtureAdapter("claude", hooks),
} });
const service: WorkspaceTaskService = {
  detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [],
  getDemo: () => undefined, getConfig: () => ({}), getWorkflowInputs: () => [],
  executePattern: async () => "Synthetic fixture only", executeWorkflow: async () => "Synthetic fixture only",
  createWorkflow: () => "Synthetic fixture only", updateDefaultModel: () => {},
};
await startInteractive({ service, panels: [createNativeSessionsPanel({ manager, workspace })] });
