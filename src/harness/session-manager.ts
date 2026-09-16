import { NativeSessionStore, SessionStoreError, captureWorkspaceIdentity, sameWorkspace,
  type NativeSessionOwnership, type NativeSessionRecord, type NativeSessionOwnerState, type WorkspaceIdentity } from "./session-store.js";
import type { NativeHarnessAdapter, NativeHarnessCapabilities, NativeHarnessCommandResult,
  NativeHarnessSessionIdentity, NativeHarnessObservation, NativeHarnessEventListener, NativeHarnessEvent,
  StartSessionCommand, ResumeSessionCommand, DisposeSessionCommand, SessionDisposed,
  ObserveSessionCommand, SendInputCommand, InterruptSessionCommand, RespondToApprovalCommand,
  CommandAccepted } from "./types.js";

export interface SessionManagerNotice { code: string; message: string; recoveryPath?: string }
export interface SessionCandidate {
  record: NativeSessionRecord;
  eligible: boolean;
  reason?: string;
  ownership?: NativeSessionOwnerState;
}
export interface NativeSessionFactoryHooks {
  /** Await after native checks and before publishing a newly confirmed native identity. */
  onNativeSessionConfirmed(identity: NativeHarnessSessionIdentity): Promise<void>;
}
export interface NativeSessionManagerOptions {
  adapters: Readonly<Record<string, (store: NativeSessionStore, hooks: NativeSessionFactoryHooks) => NativeHarnessAdapter>>;
  store?: NativeSessionStore;
}

function notice(error: unknown): SessionManagerNotice {
  return error instanceof SessionStoreError
    ? { code: error.code, message: error.message, recoveryPath: error.recoveryPath }
    : { code: "session_state_error", message: "Local session registration is unavailable. The native operation was not repeated." };
}
function rejected(message: string): NativeHarnessCommandResult<never> {
  return { status: "rejected", code: "invalid_state", message };
}
function failed(error: unknown): NativeHarnessCommandResult<never> {
  const problem = notice(error);
  return { status: "error", code: problem.code, message: problem.message };
}

/** Product entry point: explicit opens, local registration, and process ownership. */
export class NativeSessionManager {
  readonly store: NativeSessionStore;
  constructor(private readonly options: NativeSessionManagerOptions) {
    this.store = options.store ?? new NativeSessionStore();
  }

  createAdapter(adapterId: string, options: { onNotice?: (notice: SessionManagerNotice) => void } = {}): NativeHarnessAdapter {
    const factory = Object.hasOwn(this.options.adapters, adapterId) && this.options.adapters[adapterId];
    if (!factory) throw new Error("This native adapter is unavailable.");
    let managed: ManagedAdapter | undefined;
    const adapter = factory(this.store, {
      onNativeSessionConfirmed: (identity) => managed ? managed.confirmNativeSession(identity)
        : Promise.reject(new SessionStoreError("invalid_identity", "Native identity cannot be confirmed before an explicit session start.")),
    });
    if (adapter.adapterId !== adapterId) throw new Error("The native adapter factory returned a different provider.");
    managed = new ManagedAdapter(adapter, this.store, options.onNotice);
    return managed;
  }

  get adapterIds(): readonly string[] { return Object.keys(this.options.adapters); }

  async listCandidates(workspace: string): Promise<SessionCandidate[]> {
    const records = await this.store.list();
    const current = await captureWorkspaceIdentity(workspace);
    const result: SessionCandidate[] = [];
    for (const record of records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const factory = Object.hasOwn(this.options.adapters, record.adapterId) && this.options.adapters[record.adapterId];
      if (!factory) { result.push({ record, eligible: false, reason: "This native provider is unavailable." }); continue; }
      const capability = factory(this.store, {
        onNativeSessionConfirmed: () => Promise.reject(new SessionStoreError("invalid_identity", "Listing registrations does not authorize a native session.")),
      }).capabilities.resume;
      if (!capability.supported) { result.push({ record, eligible: false, reason: capability.reason }); continue; }
      if (!sameWorkspace(record.workspace, current)) {
        result.push({ record, eligible: false, reason: "This registration belongs to another or replaced workspace." }); continue;
      }
      const ownership = await this.store.inspectOwnership(record);
      result.push({ record, ownership, eligible: ownership === "available" || ownership === "stale",
        reason: ownership === "active" ? "Another Ace connection owns this session. Close it before resuming."
          : ownership === "unknown" ? "The local session owner is unknown; inspect its owner file before resuming."
          : ownership === "stale" ? "Explicit resume will recover the previous exited owner's registration." : undefined });
    }
    return result;
  }

  forget(selection: { adapterId: string; sessionId: string }): Promise<boolean> {
    return this.store.forget(selection, { requireUnowned: true });
  }

  quarantineCorruptState() { return this.store.quarantineCorruptState(); }
}

interface ManagedSession {
  reserved: NativeHarnessSessionIdentity;
  identity?: NativeHarnessSessionIdentity;
  opening: boolean;
  cancelled: boolean;
  nativeStarted: boolean;
  controller: AbortController;
  lease?: NativeSessionOwnership;
  work?: Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>>;
  disposing?: Promise<NativeHarnessCommandResult<SessionDisposed>>;
  closing?: Promise<boolean>;
  registrationAttempted?: boolean;
  nativeGeneration: number;
  terminal?: boolean;
  observers: Set<{ listener: NativeHarnessEventListener }>;
  lastSequence: number;
  openingType: "session.start" | "session.resume";
  workspace: string;
  expectedWorkspace?: WorkspaceIdentity;
  registrationIdentity?: NativeHarnessSessionIdentity;
  confirmation?: { identity: NativeHarnessSessionIdentity; work: Promise<void>; completed: boolean };
}

class ManagedAdapter implements NativeHarnessAdapter {
  readonly adapterId: string;
  readonly capabilities: NativeHarnessCapabilities;
  private current?: ManagedSession;
  constructor(private readonly adapter: NativeHarnessAdapter, private readonly store: NativeSessionStore,
    private readonly onNotice?: (notice: SessionManagerNotice) => void) {
    this.adapterId = adapter.adapterId;
    this.capabilities = adapter.capabilities;
  }

  start(command: StartSessionCommand) { return this.open({ ...command }); }
  resume(command: ResumeSessionCommand) { return this.open({ ...command }); }

  private open(command: StartSessionCommand | ResumeSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    if (this.current) return Promise.resolve(rejected("Dispose the current managed connection before opening another."));
    const session: ManagedSession = { reserved: { adapterId: this.adapterId, sessionId: command.sessionId },
      opening: true, cancelled: false, nativeStarted: false, nativeGeneration: 0, controller: new AbortController(),
      openingType: command.type, workspace: command.workspace, observers: new Set(), lastSequence: 0 };
    this.current = session; // Reserve before any asynchronous registration or native operation.
    session.work = this.performOpen(session, command);
    return session.work;
  }

  private assertOpening(session: ManagedSession): void {
    if (session.cancelled || session.terminal) throw new SessionStoreError("aborted", "Native session opening or confirmation ended. No command was replayed.");
  }

  private async performOpen(session: ManagedSession, command: StartSessionCommand | ResumeSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    try {
      const expectedWorkspace = await captureWorkspaceIdentity(command.workspace);
      session.expectedWorkspace = expectedWorkspace;
      this.assertOpening(session);
      if (command.type === "session.resume") {
        if (!this.capabilities.resume.supported) return { status: "unsupported", operation: "resume", reason: this.capabilities.resume.reason };
        if (!command.registeredSessionId || command.registeredSessionId === command.sessionId) {
          throw new SessionStoreError("invalid_identity", "Select a saved registration and use a fresh local connection ID.");
        }
        const record = await this.store.resolveForResume({ adapterId: this.adapterId, sessionId: command.registeredSessionId, workspace: command.workspace });
        if (record.nativeSessionId !== command.nativeSessionId) throw new SessionStoreError("identity_mismatch", "The selected registration does not match this native session.");
        this.assertOpening(session);
        session.lease = await this.store.acquireOwnership(record, { recoverStale: true, signal: session.controller.signal });
        if (session.lease.warning) this.report(session.lease.warning);
      }
      this.assertOpening(session);
      session.nativeStarted = true;
      const result = command.type === "session.start" ? await this.adapter.start(command) : await this.adapter.resume(command);
      if (result.status !== "ok") {
        session.nativeStarted = false; // Failed native opens finish their owned-resource cleanup before returning.
        return result;
      }
      // A late success is a new cleanup obligation even if an earlier startup disposal was acknowledged.
      session.nativeGeneration++;
      session.nativeStarted = true;
      session.closing = undefined;
      const matches = result.value.adapterId === this.adapterId && result.value.sessionId === command.sessionId &&
        (command.type !== "session.resume" || result.value.nativeSessionId === command.nativeSessionId);
      session.identity = command.type === "session.resume"
        ? { ...session.reserved, nativeSessionId: command.nativeSessionId }
        : matches ? { ...session.reserved, nativeSessionId: result.value.nativeSessionId } : { ...session.reserved };
      if (!matches) {
        throw new SessionStoreError("identity_mismatch", "The native adapter returned a different session identity.");
      }
      this.assertOpening(session);
      if (command.type === "session.start") {
        if (!session.identity.nativeSessionId) {
          this.report({ code: "native_identity_pending", message: "Native input is ready. Restart registration will become available after the harness confirms its session identity." });
        } else {
          // An ownership collision always closes this connection. Registration failures do not replay start.
          session.lease = await this.store.acquireOwnership({ adapterId: this.adapterId, nativeSessionId: session.identity.nativeSessionId }, { signal: session.controller.signal });
          if (session.lease.warning) this.report(session.lease.warning);
          this.assertOpening(session);
          try {
            session.registrationAttempted = true;
            session.registrationIdentity = { ...session.identity };
            await this.store.rememberCreatedSession(session.identity, command.workspace, { expectedWorkspace, signal: session.controller.signal });
          } catch (error) {
            this.assertOpening(session);
            const problem = notice(error);
            this.report({ ...problem, message: `The native session is usable, but restart registration is unavailable. ${problem.message}` });
          }
        }
      }
      this.assertOpening(session);
      session.opening = false;
      return { status: "ok", value: { ...session.identity } };
    } catch (error) {
      return failed(error);
    } finally {
      if (session.opening) {
        if (session.nativeStarted) await this.closeNative(session);
        await this.release(session);
        if (session.cancelled) await this.removeCancelledRegistration(session);
        if (this.current === session && !session.nativeStarted) this.current = undefined;
        if (session.nativeStarted) {
          session.cancelled = true;
          session.controller.abort();
          return { status: "error", code: "native_cleanup_failed", message: "Opening failed and native cleanup is unconfirmed. Close this connection again; its ownership was retained." };
        }
      }
    }
  }

  confirmNativeSession(identity: NativeHarnessSessionIdentity): Promise<void> {
    const session = this.current;
    const confirmed = { adapterId: identity.adapterId, sessionId: identity.sessionId, nativeSessionId: identity.nativeSessionId };
    if (!session || session.opening || session.cancelled || session.terminal || !session.nativeStarted ||
        confirmed.adapterId !== this.adapterId || confirmed.sessionId !== session.reserved.sessionId ||
        typeof confirmed.nativeSessionId !== "string" || !confirmed.nativeSessionId.trim()) {
      return Promise.reject(new SessionStoreError("invalid_identity", "Native confirmation requires this live Ace-created session and a confirmed native ID."));
    }
    if (session.confirmation) {
      return session.confirmation.identity.nativeSessionId === confirmed.nativeSessionId
        ? session.confirmation.work
        : Promise.reject(new SessionStoreError("identity_mismatch", "Native confirmation cannot replace this session's identity."));
    }
    if (session.identity?.nativeSessionId) {
      return session.identity.nativeSessionId === confirmed.nativeSessionId ? Promise.resolve()
        : Promise.reject(new SessionStoreError("identity_mismatch", "Native confirmation cannot replace this session's identity."));
    }
    if (session.openingType !== "session.start") {
      return Promise.reject(new SessionStoreError("invalid_identity", "A resumed session must retain its registered native identity."));
    }
    const confirmation = { identity: confirmed, work: Promise.resolve(), completed: false };
    session.confirmation = confirmation; // Deduplicate before any asynchronous ownership work.
    confirmation.work = this.completeNativeConfirmation(session, confirmation);
    return confirmation.work;
  }

  private async completeNativeConfirmation(session: ManagedSession, confirmation: NonNullable<ManagedSession["confirmation"]>): Promise<void> {
    try {
      const currentWorkspace = await captureWorkspaceIdentity(session.workspace);
      this.assertOpening(session);
      if (!session.expectedWorkspace || !sameWorkspace(currentWorkspace, session.expectedWorkspace)) {
        throw new SessionStoreError("identity_mismatch", "The workspace changed before the native session identity was confirmed.");
      }
      session.lease = await this.store.acquireOwnership({ adapterId: this.adapterId, nativeSessionId: confirmation.identity.nativeSessionId! }, { signal: session.controller.signal });
      if (session.lease.warning) this.report(session.lease.warning);
      this.assertOpening(session);
      let registered = false;
      try {
        session.registrationAttempted = true;
        session.registrationIdentity = { ...confirmation.identity };
        await this.store.rememberCreatedSession(confirmation.identity, session.workspace, {
          expectedWorkspace: session.expectedWorkspace, signal: session.controller.signal,
        });
        registered = true;
      } catch (error) {
        this.assertOpening(session);
        if (error instanceof SessionStoreError && error.code === "identity_mismatch") throw error;
        const problem = notice(error);
        this.report({ ...problem, message: `The native session is usable, but restart registration is unavailable. ${problem.message}` });
      }
      this.assertOpening(session);
      if (!sameWorkspace(await captureWorkspaceIdentity(session.workspace), session.expectedWorkspace)) {
        throw new SessionStoreError("identity_mismatch", "The workspace changed during native identity confirmation.");
      }
      this.assertOpening(session);
      if (registered) this.report({ code: "native_registration_ready", message: "The confirmed native session is registered for explicit resume." });
      this.assertOpening(session); // A presentation callback may synchronously close this connection.
      session.identity = { ...confirmation.identity };
      confirmation.completed = true;
    } catch (error) {
      // The native reader may be awaiting this hook. Never make rejection wait for reader disposal.
      this.stopForBoundaryFailure(session, notice(error));
      throw error;
    }
  }

  private stopForBoundaryFailure(session: ManagedSession, problem: SessionManagerNotice): void {
    const notify = !session.terminal && !session.cancelled;
    session.cancelled = true;
    session.terminal = true;
    session.controller.abort();
    // Start owned cleanup before presentation callbacks, but never await the native reader here.
    void this.closeNative(session).then(async () => {
      await this.release(session);
      await this.removeCancelledRegistration(session);
    }).catch((error) => this.report(error));
    if (!notify) return;
    const event: NativeHarnessEvent = { type: "session.error", ...(session.identity ?? session.reserved),
      sequence: ++session.lastSequence, timestamp: new Date().toISOString(),
      error: { code: problem.code, message: problem.message, retryable: false } };
    for (const observer of [...session.observers]) {
      if (!session.observers.has(observer)) continue;
      try { observer.listener(structuredClone(event)); } catch { /* One renderer cannot suppress another observer's terminal event. */ }
    }
  }

  private async removeCancelledRegistration(session: ManagedSession): Promise<void> {
    const identity = session.registrationIdentity;
    if (!session.registrationAttempted || !identity?.nativeSessionId || session.nativeStarted) return;
    try {
      const saved = (await this.store.list()).find((item) => item.adapterId === this.adapterId && item.sessionId === identity.sessionId);
      if (saved?.nativeSessionId === identity.nativeSessionId) await this.store.forget(saved, { requireUnowned: true });
    } catch (error) { this.report(error); }
  }

  observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener): NativeHarnessCommandResult<NativeHarnessObservation> {
    if (!this.live(command.session)) return rejected("Observation requires the completed managed opening result.");
    const session = this.current!;
    const observer = { listener };
    session.observers.add(observer);
    const result = this.adapter.observe(command, (event) => {
      if (this.current !== session || session.cancelled) return;
      if (event.adapterId !== this.adapterId || event.sessionId !== session.reserved.sessionId ||
          event.nativeSessionId !== session.identity?.nativeSessionId) {
        this.stopForBoundaryFailure(session, { code: "identity_mismatch",
          message: "A native event changed identity without a matching confirmation. This connection was stopped." });
        return;
      }
      session.lastSequence = Math.max(session.lastSequence, event.sequence);
      if (["session.completed", "session.cancelled", "session.error"].includes(event.type)) session.terminal = true;
      listener(event);
    });
    if (result.status !== "ok") { session.observers.delete(observer); return result; }
    return { status: "ok", value: { dispose: () => {
      session.observers.delete(observer);
      result.value.dispose();
    } } };
  }
  sendInput(command: SendInputCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    return this.live(command.session) ? this.adapter.sendInput(command) : Promise.resolve(rejected("Input requires a live managed session."));
  }
  interrupt(command: InterruptSessionCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    return this.live(command.session) ? this.adapter.interrupt(command) : Promise.resolve(rejected("Interrupt requires a live managed session."));
  }
  respondToApproval(command: RespondToApprovalCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    return this.live(command.session) ? this.adapter.respondToApproval(command) : Promise.resolve(rejected("Approval requires a live managed session."));
  }

  async dispose(command: DisposeSessionCommand): Promise<NativeHarnessCommandResult<SessionDisposed>> {
    const session = this.current;
    if (!session || command.session.adapterId !== this.adapterId || command.session.sessionId !== session.reserved.sessionId ||
        (command.session.nativeSessionId !== undefined && command.session.nativeSessionId !== session.identity?.nativeSessionId)) {
      return { status: "rejected", code: "invalid_session", message: "This managed connection does not own that session identity." };
    }
    if (session.disposing) return session.disposing;
    session.cancelled = true;
    session.controller.abort();
    session.disposing = (async () => {
      const wasOpening = session.opening;
      const pendingConfirmation = session.confirmation && !session.confirmation.completed ? session.confirmation.work : undefined;
      let closed = await this.closeNative(session);
      if (wasOpening) { await session.work; closed = !session.nativeStarted || await this.closeNative(session); }
      if (pendingConfirmation) {
        await pendingConfirmation.catch(() => {});
        closed = !session.nativeStarted || await this.closeNative(session);
      }
      if (closed) await this.release(session);
      if (pendingConfirmation) await this.removeCancelledRegistration(session);
      if (this.current === session && closed) this.current = undefined;
      return closed ? { status: "ok" as const, value: { disposed: true as const } }
        : { status: "error" as const, code: "native_cleanup_failed", message: "Native disposal did not confirm cleanup. Local ownership was retained." };
    })().finally(() => {
      if (session.nativeStarted) session.disposing = undefined; // A later explicit close can retry cleanup only.
    });
    return session.disposing;
  }

  private live(identity: NativeHarnessSessionIdentity): boolean {
    const session = this.current;
    return Boolean(session && !session.opening && !session.cancelled && !session.terminal && identity.adapterId === this.adapterId &&
      identity.sessionId === session.identity?.sessionId && identity.nativeSessionId === session.identity?.nativeSessionId);
  }

  private closeNative(session: ManagedSession): Promise<boolean> {
    if (!session.nativeStarted) return Promise.resolve(true);
    if (session.closing) return session.closing;
    const generation = session.nativeGeneration;
    const closing = (async () => {
      let result: NativeHarnessCommandResult<SessionDisposed>;
      try {
        result = await this.adapter.dispose({ type: "session.dispose", session: session.identity ?? session.reserved });
        if (session.confirmation && result.status === "rejected" && result.code === "invalid_session" && session.identity?.nativeSessionId) {
          // The hook can finish before the adapter has published/bound its identity.
          result = await this.adapter.dispose({ type: "session.dispose", session: session.reserved });
        }
      }
      catch (error) { this.report(error); return false; }
      if (result.status === "ok") {
        if (session.nativeGeneration === generation) session.nativeStarted = false;
        return session.nativeGeneration === generation;
      }
      return false;
    })().finally(() => {
      // A startup identity may bind before the opening promise resolves. Retry only disposal with its final ID.
      if (session.nativeStarted && session.closing === closing) session.closing = undefined;
    });
    session.closing = closing;
    return closing;
  }

  private async release(session: ManagedSession): Promise<void> {
    if (!session.lease || session.nativeStarted) return;
    try { await session.lease.release(); session.lease = undefined; }
    catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    const problem = error instanceof Error ? notice(error) : error as SessionManagerNotice;
    try { this.onNotice?.(problem); } catch { /* Presentation cannot repeat a native side effect. */ }
  }
}
