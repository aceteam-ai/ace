import { randomUUID } from "node:crypto";
import { captureWorkspaceIdentity, sameWorkspace, type NativeSessionRecord, type WorkspaceIdentity } from "../harness/session-store.js";
import type { SessionManagerNotice } from "../harness/session-manager.js";
import type { CommandAccepted, NativeHarnessAdapter, NativeHarnessCommandResult, NativeHarnessObservation, NativeHarnessSessionIdentity } from "../harness/types.js";
import { initialNativeSessionState, nativeText, nativeTurnKey, reduceNativeEvent, type NativeSessionState } from "./native-session-state.js";

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
  private initialInputPending = false;
  private initialInputOwner?: object;
  private readonly localOperations = new Set<Promise<unknown>>();

  constructor(readonly adapter: NativeHarnessAdapter) {}
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

  runLocalOperation = <T>(action: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(() => {
      if (this.disposed) throw new Error("The native workspace is closing.");
      return action();
    });
    this.localOperations.add(operation);
    return operation.finally(() => { this.localOperations.delete(operation); });
  };

  reportRegistrationNotice = (notice: SessionManagerNotice): void => {
    if (this.disposed) return;
    if (notice.code === "native_registration_ready") {
      this.update({ ...this.state, registrationStatus: "ready", registrationNotice: undefined });
    } else this.update({ ...this.state, registrationStatus: notice.code === "native_identity_pending" ? "pending" : "unavailable",
      registrationNotice: nativeText(`${notice.message}${notice.recoveryPath ? ` Recovery path: ${notice.recoveryPath}` : ""}`) });
  };

  canStartFresh = (): boolean => !this.disposed && !this.identity && !this.opening && !this.closing && !this.initialInputPending && ["idle", "closed", "error"].includes(this.state.phase);

  start(workspace: string): Promise<StartResult> { return this.initialInputPending ? Promise.resolve(closedResult()) : this.open(workspace); }

  /** One explicit reviewed input reserves a new session; readiness listeners cannot inject another input. */
  async startWithInput(workspace: string, input: string, expectedWorkspace: WorkspaceIdentity, owner: object): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    if (!this.canStartFresh()) return closedResult();
    this.initialInputPending = true;
    this.initialInputOwner = owner;
    const priorEpoch = this.epoch;
    const verify = async () => {
      if (!sameWorkspace(await captureWorkspaceIdentity(workspace), expectedWorkspace)) throw new Error("The reviewed handoff workspace changed. Load and review the handoff again.");
    };
    try {
      await verify();
      if (this.epoch !== priorEpoch || this.disposed || this.closing) return closedResult();
      const started = await this.open(workspace);
      if (started.status !== "ok") return started;
      const epoch = this.epoch;
      await verify();
      if (!this.current(epoch)) return closedResult();
      return await this.sendInputCommand(input, true);
    } catch (error) {
      await this.close();
      const result = failure(error);
      this.update({ ...this.state, phase: "error", notice: nativeText(message(result)) });
      return result;
    } finally { this.initialInputPending = false; }
  }

  /** An old review cannot close a later connection that reused this view service. */
  async cancelInitialInput(owner: object): Promise<boolean> {
    if (this.initialInputOwner !== owner) return true;
    await this.close();
    return this.initialInputOwner !== owner;
  }

  resume(record: NativeSessionRecord, workspace: string): Promise<StartResult> {
    if (this.initialInputPending) return Promise.resolve(closedResult());
    if (record.adapterId !== this.adapter.adapterId) return Promise.resolve({ status: "rejected", code: "adapter_mismatch", message: "Choose the native provider that created this registration." });
    const capability = this.adapter.capabilities.resume;
    if (!capability.supported) return Promise.resolve({ status: "unsupported", operation: "resume", reason: capability.reason });
    return this.open(workspace, { ...record });
  }

  private async open(workspace: string, saved?: NativeSessionRecord): Promise<StartResult> {
    if (this.disposed || this.opening || this.closing || !["idle", "closed", "error"].includes(this.state.phase)) return closedResult();
    if (this.identity) await this.close();
    if (this.disposed || this.identity || this.opening || this.closing) return closedResult();
    const epoch = ++this.epoch;
    const identity = { adapterId: this.adapter.adapterId, sessionId: randomUUID() };
    this.identity = identity;
    const pending = Promise.resolve().then(() => this.current(epoch)
      ? saved ? this.adapter.resume({ type: "session.resume", sessionId: identity.sessionId, registeredSessionId: saved.sessionId, nativeSessionId: saved.nativeSessionId, workspace })
        : this.adapter.start({ type: "session.start", sessionId: identity.sessionId, workspace }) : closedResult());
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
      this.state = { ...this.state, identity: result.value, connectionKind: saved ? "resumed" : "new" };
      const observed = this.adapter.observe({ type: "session.observe", session: result.value }, (event) => {
        if (!this.current(epoch)) return;
        const current = this.identity;
        if (current && event.adapterId === current.adapterId && event.sessionId === current.sessionId &&
            current.nativeSessionId !== undefined && event.nativeSessionId !== current.nativeSessionId) {
          void this.commandError({ status: "error", code: "identity_mismatch", message: "The native session changed its confirmed identity. This connection was closed." }, epoch);
          return;
        }
        const next = reduceNativeEvent(this.state, event);
        // Commands triggered synchronously by a render listener must use the newly confirmed identity.
        this.identity = next.identity;
        this.update(next);
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

  sendInput(input: string): Promise<NativeHarnessCommandResult<CommandAccepted>> { return this.sendInputCommand(input, false); }

  private async sendInputCommand(input: string, initial: boolean): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    if (this.initialInputPending && !initial) return closedResult();
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
    const epoch = this.epoch; const turnId = nativeTurnKey(this.state);
    this.update({ ...this.state, interruptPending: true });
    if (!this.current(epoch)) return closedResult();
    const result = await this.invoke(() => this.adapter.interrupt({ type: "session.interrupt", session: identity }));
    if (this.current(epoch) && turnId === nativeTurnKey(this.state)) {
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
      if (!errors.length) this.initialInputOwner = undefined;
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
    try { await this.close(); await Promise.allSettled([...this.localOperations]); } finally { this.listeners.clear(); }
  }
}
