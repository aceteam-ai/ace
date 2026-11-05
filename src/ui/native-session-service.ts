import { randomUUID } from "node:crypto";
import { CodexNativeHarnessAdapter } from "../harness/codex.js";
import type { CommandAccepted, NativeHarnessAdapter, NativeHarnessCommandResult, NativeHarnessObservation, NativeHarnessSessionIdentity } from "../harness/types.js";
import { initialNativeSessionState, nativeText, reduceNativeEvent, type NativeSessionState } from "./native-session-state.js";

type StartResult = NativeHarnessCommandResult<NativeHarnessSessionIdentity>;
function closedResult(): NativeHarnessCommandResult<never> {
  return { status: "rejected", code: "invalid_state", message: "The native session is closing or unavailable." };
}
function failure(error: unknown): NativeHarnessCommandResult<never> {
  return { status: "error", code: "native_session_failed", message: nativeText(error instanceof Error ? error.message : error) };
}
function message(result: NativeHarnessCommandResult<unknown>): string | undefined {
  return result.status === "ok" ? undefined : result.status === "unsupported" ? result.reason : result.message;
}

/** Owns one adapter and view state across panel navigation; no persistence or credential handling. */
export class NativeSessionService {
  private state = initialNativeSessionState();
  private readonly listeners = new Set<() => void>();
  private identity?: NativeHarnessSessionIdentity;
  private observation?: NativeHarnessObservation;
  private opening?: Promise<StartResult>;
  private closing?: Promise<void>;
  private disposed = false;
  private epoch = 0;
  private inputAttempt = 0;

  constructor(readonly adapter: NativeHarnessAdapter = new CodexNativeHarnessAdapter()) {}
  getSnapshot = (): NativeSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(state: NativeSessionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Rendering cannot change native lifecycle. */ }
    }
  }
  private current(epoch: number): boolean { return epoch === this.epoch && !this.disposed && !this.closing; }
  private notice(result: NativeHarnessCommandResult<unknown>): void {
    const detail = message(result);
    if (detail) this.update({ ...this.state, notice: nativeText(detail) });
  }
  private async invoke<T>(action: () => Promise<NativeHarnessCommandResult<T>>): Promise<NativeHarnessCommandResult<T>> {
    try { return await action(); } catch (error) { return failure(error); }
  }
  private async commandError(result: NativeHarnessCommandResult<unknown>, epoch: number): Promise<void> {
    if (result.status !== "error" || !this.current(epoch)) return;
    // An unreported command failure has an unknown native outcome. Close before allowing new work.
    await this.close();
    if (!this.disposed && this.epoch === epoch + 1) this.update({ ...this.state, phase: "error", notice: nativeText(result.message) });
  }

  async start(workspace: string): Promise<StartResult> {
    if (this.disposed || this.opening || this.closing || !["idle", "closed", "error"].includes(this.state.phase)) return closedResult();
    if (this.identity) await this.close();
    if (this.disposed || this.identity || this.opening || this.closing) return closedResult();
    const epoch = ++this.epoch;
    const identity = { adapterId: this.adapter.adapterId, sessionId: randomUUID() };
    this.identity = identity;
    const pending = Promise.resolve().then(() => this.current(epoch)
      ? this.adapter.start({ type: "session.start", sessionId: identity.sessionId, workspace }) : closedResult());
    this.opening = pending;
    this.update({ ...initialNativeSessionState(), phase: "starting", workspace, identity });
    try {
      const result = await pending;
      if (!this.current(epoch)) return closedResult(); // Close owns cleanup of this pending result.
      if (result.status !== "ok") {
        this.update({ ...this.state, phase: "error", notice: nativeText(message(result)) });
        return result;
      }
      this.identity = result.value;
      // Publish readiness only after the observer is registered; a ready listener may send input immediately.
      this.state = { ...this.state, identity: result.value };
      const observed = this.adapter.observe({ type: "session.observe", session: result.value }, (event) => {
        if (this.current(epoch)) this.update(reduceNativeEvent(this.state, event));
      });
      if (!this.current(epoch)) {
        if (observed.status === "ok") observed.value.dispose();
        return closedResult();
      }
      if (observed.status !== "ok") {
        await this.close();
        if (!this.disposed && this.epoch === epoch + 1) this.update({ ...this.state, phase: "error", notice: nativeText(message(observed)) });
        return observed;
      }
      this.observation = observed.value;
      if (this.state.phase === "starting") this.update({ ...this.state, phase: "ready" });
      return this.current(epoch) ? result : closedResult();
    } catch (error) {
      const result = failure(error);
      await this.commandError(result, epoch);
      return result;
    } finally {
      if (this.opening === pending) this.opening = undefined;
    }
  }

  async sendInput(input: string): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const identity = this.identity;
    if (!identity || this.state.phase !== "ready" || this.closing || this.disposed) return closedResult();
    const epoch = this.epoch; const attempt = ++this.inputAttempt; const sequence = this.state.lastSequence;
    this.update({ ...this.state, phase: "running", notice: undefined });
    if (!this.current(epoch)) return closedResult();
    const result = await this.invoke(() => this.adapter.sendInput({ type: "session.input", session: identity, input }));
    if (this.current(epoch) && attempt === this.inputAttempt) {
      await this.commandError(result, epoch);
      if (this.current(epoch)) {
        if (result.status !== "ok" && this.state.lastSequence === sequence && this.getSnapshot().phase === "running") this.update({ ...this.state, phase: "ready" });
        if (this.current(epoch)) this.notice(result);
      }
    }
    return result;
  }

  async interrupt(): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const identity = this.identity;
    if (!identity || !["running", "waiting_for_approval"].includes(this.state.phase) || this.state.interruptPending || this.disposed || this.closing) return closedResult();
    const epoch = this.epoch; const turnId = this.state.nativeTurnId;
    this.update({ ...this.state, interruptPending: true });
    if (!this.current(epoch)) return closedResult();
    const result = await this.invoke(() => this.adapter.interrupt({ type: "session.interrupt", session: identity }));
    if (this.current(epoch) && turnId === this.state.nativeTurnId) {
      await this.commandError(result, epoch);
      if (this.current(epoch)) {
        if (result.status !== "ok") this.update({ ...this.state, interruptPending: false });
        if (this.current(epoch)) this.notice(result);
      }
    }
    return result;
  }

  async respond(approvalId: string, decision: string): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const identity = this.identity;
    const approval = this.state.approvals.find((entry) => entry.id === approvalId);
    if (!identity || !approval || approval.status !== "waiting" || !approval.choices.includes(decision) || this.disposed || this.closing) return closedResult();
    const epoch = this.epoch;
    this.update({ ...this.state, approvals: this.state.approvals.map((entry) => entry.id === approvalId ? { ...entry, status: "submitting" } : entry) });
    if (!this.current(epoch)) return closedResult();
    const result = await this.invoke(() => this.adapter.respondToApproval({ type: "approval.respond", session: identity, approvalId, correlationId: approval.correlationId, decision }));
    if (this.current(epoch)) {
      await this.commandError(result, epoch);
      if (this.current(epoch)) {
        // A rejected prompt is no longer actionable. Native resolution remains authoritative.
        this.update({ ...this.state, approvals: result.status === "rejected" ? this.state.approvals.filter((entry) => entry.id !== approvalId)
          : this.state.approvals.map((entry) => entry.id === approvalId ? { ...entry, status: result.status === "ok" ? "submitted" : "waiting" } : entry) });
        if (this.current(epoch)) this.notice(result);
      }
    }
    return result;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const identity = this.identity;
    const pending = this.opening;
    const observation = this.observation;
    ++this.epoch;
    this.observation = undefined;
    this.closing = Promise.resolve().then(async () => {
      const errors: string[] = [];
      const release = async (session: NativeHarnessSessionIdentity) => {
        try {
          const result = await this.adapter.dispose({ type: "session.dispose", session });
          if (result.status === "error" || result.status === "unsupported") errors.push(message(result) ?? "Native cleanup failed.");
        } catch (error) { errors.push(nativeText(error instanceof Error ? error.message : error)); }
      };
      try { observation?.dispose(); } catch (error) { errors.push(nativeText(error)); }
      if (identity) await release(identity);
      // Always await a pending start, even if the provisional dispose failed.
      if (pending) {
        const started = await pending.catch(() => undefined);
        if (started?.status === "ok") await release(started.value);
      }
      this.identity = errors.length ? identity : undefined;
      this.closing = undefined;
      this.update({ ...this.state, phase: errors.length ? "error" : "closed", identity: undefined, approvals: [], interruptPending: false,
        notice: errors.length ? nativeText(`Native cleanup failed: ${errors.join("; ")}`) : this.state.notice });
    });
    const closing = this.closing;
    this.update({ ...this.state, phase: "closing", approvals: [], interruptPending: false });
    return closing;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.close(); } finally { this.listeners.clear(); }
  }
}
