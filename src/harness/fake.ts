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
    { correlationId: string | undefined; choices: ReadonlySet<string> }
  >;
  sequence: number;
  state: "active" | "completed" | "cancelled" | "error";
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
}

const supported: NativeHarnessCapability = { supported: true };

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

  constructor(options: FakeNativeHarnessAdapterOptions = {}) {
    this.adapterId = options.adapterId ?? "fake";
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

    this.publish(
      session.value,
      {
        type: "conversation.message",
        role: "user",
        text: command.input,
      },
      command.correlationId
    );
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

    this.publish(
      session.value,
      { type: "session.cancelled", reason: command.reason },
      command.correlationId
    );
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

  private publish(
    session: FakeSession,
    payload: NativeHarnessEventPayload,
    correlationId?: string
  ): NativeHarnessEvent {
    session.sequence += 1;
    const event: NativeHarnessEvent = {
      ...payload,
      ...session.identity,
      correlationId,
      sequence: session.sequence,
      timestamp: this.now(),
    };

    if (payload.type === "approval.requested") {
      session.pendingApprovals.set(payload.approvalId, {
        correlationId,
        choices: new Set(payload.choices),
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

    for (const listener of session.listeners) {
      listener(event);
    }

    return event;
  }
}
