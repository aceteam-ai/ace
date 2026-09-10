import { NativeSessionStore, SessionStoreError, captureWorkspaceIdentity, sameWorkspace,
  type NativeSessionOwnership, type NativeSessionRecord, type NativeSessionOwnerState } from "./session-store.js";
import type { NativeHarnessAdapter, NativeHarnessCapabilities, NativeHarnessCommandResult,
  NativeHarnessSessionIdentity, NativeHarnessObservation, NativeHarnessEventListener,
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
export interface NativeSessionManagerOptions {
  adapters: Readonly<Record<string, (store: NativeSessionStore) => NativeHarnessAdapter>>;
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
    const adapter = factory(this.store);
    if (adapter.adapterId !== adapterId) throw new Error("The native adapter factory returned a different provider.");
    return new ManagedAdapter(adapter, this.store, options.onNotice);
  }

  async listCandidates(workspace: string): Promise<SessionCandidate[]> {
    const records = await this.store.list();
    const current = await captureWorkspaceIdentity(workspace);
    const result: SessionCandidate[] = [];
    for (const record of records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const factory = Object.hasOwn(this.options.adapters, record.adapterId) && this.options.adapters[record.adapterId];
      if (!factory) { result.push({ record, eligible: false, reason: "This native provider is unavailable." }); continue; }
      const capability = factory(this.store).capabilities.resume;
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
      opening: true, cancelled: false, nativeStarted: false, nativeGeneration: 0, controller: new AbortController() };
    this.current = session; // Reserve before any asynchronous registration or native operation.
    session.work = this.performOpen(session, command);
    return session.work;
  }

  private assertOpening(session: ManagedSession): void {
    if (session.cancelled) throw new SessionStoreError("aborted", "Native session opening was cancelled. No command was replayed.");
  }

  private async performOpen(session: ManagedSession, command: StartSessionCommand | ResumeSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    try {
      const expectedWorkspace = await captureWorkspaceIdentity(command.workspace);
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
      session.identity = { ...session.reserved, nativeSessionId: command.type === "session.resume" ? command.nativeSessionId : result.value.nativeSessionId };
      if (result.value.adapterId !== this.adapterId || result.value.sessionId !== command.sessionId ||
          (command.type === "session.resume" && result.value.nativeSessionId !== command.nativeSessionId)) {
        throw new SessionStoreError("identity_mismatch", "The native adapter returned a different session identity.");
      }
      this.assertOpening(session);
      if (command.type === "session.start") {
        if (!session.identity.nativeSessionId) {
          this.report(new SessionStoreError("invalid_identity", "Native session opened without a confirmed native ID. It remains usable; restart registration is unavailable."));
        } else {
          // An ownership collision always closes this connection. Registration failures do not replay start.
          session.lease = await this.store.acquireOwnership({ adapterId: this.adapterId, nativeSessionId: session.identity.nativeSessionId }, { signal: session.controller.signal });
          if (session.lease.warning) this.report(session.lease.warning);
          this.assertOpening(session);
          try {
            session.registrationAttempted = true;
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
        if (session.cancelled && session.registrationAttempted && session.identity?.nativeSessionId && !session.nativeStarted) {
          try {
            const saved = (await this.store.list()).find((item) => item.adapterId === this.adapterId && item.sessionId === session.identity!.sessionId);
            if (saved?.nativeSessionId === session.identity.nativeSessionId) await this.store.forget(saved);
          } catch (error) { this.report(error); }
        }
        if (this.current === session && !session.nativeStarted) this.current = undefined;
        if (session.nativeStarted) {
          session.cancelled = true;
          session.controller.abort();
          return { status: "error", code: "native_cleanup_failed", message: "Opening failed and native cleanup is unconfirmed. Close this connection again; its ownership was retained." };
        }
      }
    }
  }

  observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener): NativeHarnessCommandResult<NativeHarnessObservation> {
    if (!this.live(command.session)) return rejected("Observation requires the completed managed opening result.");
    return this.adapter.observe(command, listener);
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
      let closed = await this.closeNative(session);
      if (wasOpening) { await session.work; closed = !session.nativeStarted || await this.closeNative(session); }
      if (closed) await this.release(session);
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
    return Boolean(session && !session.opening && !session.cancelled && identity.adapterId === this.adapterId &&
      identity.sessionId === session.identity?.sessionId && identity.nativeSessionId === session.identity?.nativeSessionId);
  }

  private closeNative(session: ManagedSession): Promise<boolean> {
    if (!session.nativeStarted) return Promise.resolve(true);
    if (session.closing) return session.closing;
    const generation = session.nativeGeneration;
    const closing = (async () => {
      let result: NativeHarnessCommandResult<SessionDisposed>;
      try { result = await this.adapter.dispose({ type: "session.dispose", session: session.identity ?? session.reserved }); }
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
