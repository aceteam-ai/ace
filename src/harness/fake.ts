import {
  type CommandAccepted,
  type DisposeSessionCommand,
  type InterruptSessionCommand,
  type NativeDetails,
  type NativeHarnessAdapter,
  type NativeHarnessCapabilities,
  type NativeHarnessCapability,
  type NativeHarnessCommandResult,
  type NativeHarnessEvent,
  type NativeHarnessEventListener,
  type NativeHarnessEventPayload,
  type NativeHarnessObservation,
  type NativeHarnessOperation,
  type NativeHarnessSessionIdentity,
  type NativeHarnessTurnIdentity,
  type ObserveSessionCommand,
  type RespondToApprovalCommand,
  type ResumeSessionCommand,
  type SendInputCommand,
  type SessionDisposed,
  type StartSessionCommand,
} from "./types.js";

interface FakeSession {
  identity: NativeHarnessSessionIdentity;
  listeners: Set<NativeHarnessEventListener>;
  pendingApprovals: Map<
    string,
    { correlationId: string | undefined; choices: ReadonlySet<string>; nativeTurnId?: string; turnId?: string }
  >;
  sequence: number;
  turnCounter: number;
  nativeTurnId?: string;
  turnId?: string;
  turnEnding: boolean;
  usedTurnIds: Set<string>;
  usedApprovalIds: Set<string>;
  state: "active" | "completed" | "cancelled" | "error";
  eventQueue: Array<{ event: NativeHarnessEvent; after?: () => void }>;
  publishing: boolean;
}

interface KnownNativeSession {
  workspace: string;
}

interface FakeFailure {
  code: string;
  message: string;
  nativeDetails?: NativeDetails;
}

export interface FakeNativeHarnessAdapterOptions {
  adapterId?: string;
  capabilities?: Partial<NativeHarnessCapabilities>;
  now?: () => string;
  nativeSessionId?: (sessionId: string) => string;
  turnIdentity?: "native" | "local";
}

const supported: NativeHarnessCapability = { supported: true };
const turnKey = (value: { nativeTurnId?: string; turnId?: string }) => value.nativeTurnId ?? value.turnId;
const requiredTurnKey = (value: NativeHarnessTurnIdentity): string => value.nativeTurnId ?? value.turnId!;

function defaultCapabilities(): NativeHarnessCapabilities {
  return {
    start: supported,
    sendInput: supported,
    observe: supported,
    interrupt: supported,
    respondToApproval: supported,
    resume: {
      supported: false,
      reason: "This adapter does not support session resume.",
    },
    dispose: supported,
  };
}

export class FakeNativeHarnessAdapter implements NativeHarnessAdapter {
  readonly adapterId: string;
  readonly capabilities: NativeHarnessCapabilities;

  private readonly sessions = new Map<string, FakeSession>();
  private readonly usedSessionIds = new Set<string>();
  private readonly knownNativeSessions = new Map<string, KnownNativeSession>();
  private readonly failures = new Map<NativeHarnessOperation, FakeFailure>();
  private readonly now: () => string;
  private readonly createNativeSessionId: (sessionId: string) => string;
  private readonly turnIdentity: "native" | "local";

  constructor(options: FakeNativeHarnessAdapterOptions = {}) {
    this.adapterId = options.adapterId ?? "fake";
    this.turnIdentity = options.turnIdentity ?? "native";
    this.capabilities = {
      ...defaultCapabilities(),
      ...options.capabilities,
    };
    this.now = options.now ?? (() => "1970-01-01T00:00:00.000Z");
    this.createNativeSessionId =
      options.nativeSessionId ?? ((sessionId) => `native-${sessionId}`);
  }

  async start(
    command: StartSessionCommand
  ): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    const blocked = this.beforeOperation("start");
    if (blocked) {
      return blocked;
    }
    if (this.usedSessionIds.has(command.sessionId)) {
      return {
        status: "rejected",
        code: "duplicate_session",
        message: `Session ${command.sessionId} has already been used by this adapter.`,
      };
    }

    const nativeSessionId = this.createNativeSessionId(command.sessionId);
    const identity: NativeHarnessSessionIdentity = {
      adapterId: this.adapterId,
      sessionId: command.sessionId,
      nativeSessionId,
    };
    this.sessions.set(command.sessionId, this.createSession(identity));
    this.usedSessionIds.add(command.sessionId);
    this.knownNativeSessions.set(nativeSessionId, {
      workspace: command.workspace,
    });
    return { status: "ok", value: identity };
  }

  async sendInput(
    command: SendInputCommand
  ): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const blocked = this.beforeOperation("sendInput");
    if (blocked) {
      return blocked;
    }
    const session = this.activeSession(command.session);
    if (session.status !== "ok") {
      return session;
    }

    if (turnKey(session.value) || session.value.turnEnding || session.value.pendingApprovals.size) {
      return { status: "rejected", code: "invalid_state", message: "Input requires a ready fake session; steering is unsupported." };
    }
    const id = `${this.turnIdentity === "native" ? session.value.identity.nativeSessionId : session.value.identity.sessionId}:turn-${++session.value.turnCounter}`;
    const identity: NativeHarnessTurnIdentity = this.turnIdentity === "native" ? { nativeTurnId: id } : { turnId: id };
    this.publish(session.value, { type: "turn.started", ...identity }, command.correlationId);
    if (session.value.state === "active" && turnKey(session.value) === id) {
      this.publish(session.value, { type: "session.state", state: "running" }, id);
      if (session.value.state === "active" && turnKey(session.value) === id && !session.value.turnEnding) {
        this.publish(session.value, { type: "conversation.message", role: "user", text: command.input }, command.correlationId);
      }
    }
    return { status: "ok", value: { accepted: true } };
  }

  observe(
    command: ObserveSessionCommand,
    listener: NativeHarnessEventListener
  ): NativeHarnessCommandResult<NativeHarnessObservation> {
    const blocked = this.beforeOperation("observe");
    if (blocked) {
      return blocked;
    }
    const session = this.session(command.session);
    if (session.status !== "ok") {
      return session;
    }

    session.value.listeners.add(listener);
    let disposed = false;
    return {
      status: "ok",
      value: {
        dispose: () => {
          if (!disposed) {
            session.value.listeners.delete(listener);
            disposed = true;
          }
        },
      },
    };
  }

  async interrupt(
    command: InterruptSessionCommand
  ): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const blocked = this.beforeOperation("interrupt");
    if (blocked) {
      return blocked;
    }
    const session = this.activeSession(command.session);
    if (session.status !== "ok") {
      return session;
    }

    if (!turnKey(session.value) || session.value.turnEnding) {
      return { status: "rejected", code: "invalid_state", message: "Interrupt requires an active fake turn." };
    }
    this.completeTurn(session.value, {
      type: "turn.completed", ...(session.value.nativeTurnId ? { nativeTurnId: session.value.nativeTurnId } : { turnId: session.value.turnId! }),
      outcome: "interrupted", nativeDetails: { reason: command.reason },
    }, command.correlationId);
    return { status: "ok", value: { accepted: true } };
  }

  async respondToApproval(
    command: RespondToApprovalCommand
  ): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const blocked = this.beforeOperation("respondToApproval");
    if (blocked) {
      return blocked;
    }
    const session = this.activeSession(command.session);
    if (session.status !== "ok") {
      return session;
    }

    const pendingApproval = session.value.pendingApprovals.get(command.approvalId);
    if (!pendingApproval) {
      return {
        status: "rejected",
        code: "stale_approval",
        message: "The approval request is no longer pending for this session.",
      };
    }

    if (pendingApproval.correlationId !== command.correlationId) {
      return {
        status: "rejected",
        code: "approval_mismatch",
        message: "The approval response does not match the pending request.",
      };
    }
    if (!pendingApproval.choices.has(command.decision)) {
      return {
        status: "rejected",
        code: "invalid_approval_decision",
        message: "The approval response was not one of the offered choices.",
      };
    }

    this.publish(
      session.value,
      {
        type: "approval.resolved",
        approvalId: command.approvalId,
        decision: command.decision,
      },
      command.correlationId
    );
    return { status: "ok", value: { accepted: true } };
  }

  async resume(
    command: ResumeSessionCommand
  ): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    const blocked = this.beforeOperation("resume");
    if (blocked) {
      return blocked;
    }
    if (this.usedSessionIds.has(command.sessionId)) {
      return {
        status: "rejected",
        code: "duplicate_session",
        message: `Session ${command.sessionId} has already been used by this adapter.`,
      };
    }
    const knownSession = this.knownNativeSessions.get(command.nativeSessionId);
    if (!knownSession || knownSession.workspace !== command.workspace) {
      return {
        status: "rejected",
        code: "invalid_session",
        message: "The native session is not eligible for resume in this workspace.",
      };
    }

    const identity: NativeHarnessSessionIdentity = {
      adapterId: this.adapterId,
      sessionId: command.sessionId,
      nativeSessionId: command.nativeSessionId,
    };
    this.sessions.set(command.sessionId, this.createSession(identity));
    this.usedSessionIds.add(command.sessionId);
    return { status: "ok", value: identity };
  }

  async dispose(
    command: DisposeSessionCommand
  ): Promise<NativeHarnessCommandResult<SessionDisposed>> {
    const blocked = this.beforeOperation("dispose");
    if (blocked) {
      return blocked;
    }
    const session = this.session(command.session);
    if (session.status !== "ok") {
      return session;
    }

    session.value.listeners.clear();
    session.value.pendingApprovals.clear();
    this.sessions.delete(command.session.sessionId);
    return { status: "ok", value: { disposed: true } };
  }

  emit(
    identity: NativeHarnessSessionIdentity,
    payload: NativeHarnessEventPayload,
    correlationId?: string
  ): NativeHarnessCommandResult<NativeHarnessEvent> {
    const session = this.activeSession(identity);
    if (session.status !== "ok") {
      return session;
    }

    if (payload.type === "turn.started" && (turnKey(session.value) || session.value.turnEnding || session.value.usedTurnIds.has(requiredTurnKey(payload)))) {
      return { status: "rejected", code: "invalid_state", message: "A new unique turn requires a ready session." };
    }
    if (payload.type === "turn.completed") {
      if (session.value.nativeTurnId !== payload.nativeTurnId || session.value.turnId !== payload.turnId || session.value.turnEnding) {
        return { status: "rejected", code: "invalid_state", message: "The completed turn is not active." };
      }
      return { status: "ok", value: this.completeTurn(session.value, payload, correlationId) };
    }
    if (payload.type === "approval.requested" && (session.value.turnEnding || session.value.usedApprovalIds.has(payload.approvalId))) {
      return { status: "rejected", code: "stale_approval", message: "Approval IDs cannot be reused or created for an ending turn." };
    }
    return {
      status: "ok",
      value: this.publish(session.value, payload, correlationId),
    };
  }

  failNext(operation: NativeHarnessOperation, failure: FakeFailure): void {
    this.failures.set(operation, failure);
  }

  private createSession(identity: NativeHarnessSessionIdentity): FakeSession {
    return {
      identity,
      listeners: new Set(),
      pendingApprovals: new Map(),
      sequence: 0,
      turnCounter: 0,
      turnEnding: false,
      usedTurnIds: new Set(),
      usedApprovalIds: new Set(),
      eventQueue: [],
      publishing: false,
      state: "active",
    };
  }

  private beforeOperation(
    operation: NativeHarnessOperation
  ): Exclude<NativeHarnessCommandResult<never>, { status: "ok" }> | undefined {
    const capability = this.capabilities[operation];
    if (!capability.supported) {
      return {
        status: "unsupported",
        operation,
        reason: capability.reason,
      };
    }

    const failure = this.failures.get(operation);
    if (failure) {
      this.failures.delete(operation);
      return { status: "error", ...failure };
    }
    return undefined;
  }

  private session(
    identity: NativeHarnessSessionIdentity
  ): NativeHarnessCommandResult<FakeSession> {
    if (identity.adapterId !== this.adapterId) {
      return {
        status: "rejected",
        code: "adapter_mismatch",
        message: "The session belongs to a different adapter.",
      };
    }

    const session = this.sessions.get(identity.sessionId);
    if (
      !session ||
      session.identity.nativeSessionId !== identity.nativeSessionId
    ) {
      return {
        status: "rejected",
        code: "invalid_session",
        message: "The session identity is not active in this adapter.",
      };
    }
    return { status: "ok", value: session };
  }

  private activeSession(
    identity: NativeHarnessSessionIdentity
  ): NativeHarnessCommandResult<FakeSession> {
    const result = this.session(identity);
    if (result.status !== "ok") {
      return result;
    }
    if (result.value.state !== "active") {
      return {
        status: "rejected",
        code: "invalid_state",
        message: `Session is already ${result.value.state}.`,
      };
    }
    return result;
  }

  private completeTurn(
    session: FakeSession,
    payload: Extract<NativeHarnessEventPayload, { type: "turn.completed" }>,
    correlationId?: string
  ): NativeHarnessEvent {
    session.turnEnding = true;
    const approvals = [...session.pendingApprovals.entries()];
    session.pendingApprovals.clear();
    for (const [approvalId, approval] of approvals) {
      this.publish(session, {
        type: "approval.resolved", approvalId, decision: "expired",
        nativeDetails: { resolution: "turn_ended" },
      }, approval.correlationId);
    }
    return this.publish(session, payload, correlationId ?? requiredTurnKey(payload), () => {
      session.nativeTurnId = undefined;
      session.turnId = undefined;
      session.turnEnding = false;
      if (session.state === "active" && this.sessions.get(session.identity.sessionId) === session) {
        this.publish(session, { type: "session.state", state: "ready" }, requiredTurnKey(payload));
      }
    });
  }

  private publish(
    session: FakeSession,
    payload: NativeHarnessEventPayload,
    correlationId?: string,
    after?: () => void
  ): NativeHarnessEvent {
    session.sequence += 1;
    const event: NativeHarnessEvent = {
      nativeTurnId: session.nativeTurnId,
      turnId: session.turnId,
      ...payload,
      ...session.identity,
      correlationId,
      sequence: session.sequence,
      timestamp: this.now(),
    };

    // A reentrant terminal event must not be followed by an older completion or ready event.
    if (session.state !== "active" || this.sessions.get(session.identity.sessionId) !== session) return event;
    if (payload.type === "turn.started") {
      session.nativeTurnId = payload.nativeTurnId;
      session.turnId = payload.turnId;
      session.usedTurnIds.add(requiredTurnKey(payload));
    } else if (payload.type === "approval.requested") {
      session.usedApprovalIds.add(payload.approvalId);
      session.pendingApprovals.set(payload.approvalId, {
        correlationId,
        choices: new Set(payload.choices),
        nativeTurnId: session.nativeTurnId,
        turnId: session.turnId,
      });
    } else if (payload.type === "approval.resolved") {
      session.pendingApprovals.delete(payload.approvalId);
    } else if (payload.type === "session.completed") {
      session.state = "completed";
      session.pendingApprovals.clear();
    } else if (payload.type === "session.cancelled") {
      session.state = "cancelled";
      session.pendingApprovals.clear();
    } else if (payload.type === "session.error") {
      session.state = "error";
      session.pendingApprovals.clear();
    }

    session.eventQueue.push({ event: structuredClone(event), after });
    if (!session.publishing) {
      session.publishing = true;
      try {
        while (session.eventQueue.length && this.sessions.get(session.identity.sessionId) === session) {
          const queued = session.eventQueue.shift()!;
          for (const listener of [...session.listeners]) {
            if (this.sessions.get(session.identity.sessionId) !== session) break;
            if (session.listeners.has(listener)) {
              try { listener(structuredClone(queued.event)); } catch { /* Renderer owns its failures. */ }
            }
          }
          if (this.sessions.get(session.identity.sessionId) === session) queued.after?.();
        }
      } finally {
        session.publishing = false;
        session.eventQueue.length = 0;
      }
    }
    return event;
  }
}
