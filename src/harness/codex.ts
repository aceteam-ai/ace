import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  asCodexError, checkCodexVersion, CodexError, CodexRpc, object, rpcId,
  spawnCodex, stopChild, TESTED_CODEX_VERSION,
  type CodexProcessFactory, type CodexRpcCall, type JsonObject, type RpcId,
} from "./codex-protocol.js";
import type {
  CommandAccepted, DisposeSessionCommand, InterruptSessionCommand,
  NativeHarnessAdapter, NativeHarnessCapabilities, NativeHarnessCommandResult,
  NativeHarnessEvent, NativeHarnessEventListener, NativeHarnessEventPayload,
  NativeHarnessObservation, NativeHarnessRejectionCode, NativeHarnessSessionIdentity,
  NativeHarnessSessionState, NativeHarnessTurnOutcome, ObserveSessionCommand, RespondToApprovalCommand,
  ResumeSessionCommand, SendInputCommand, SessionDisposed, StartSessionCommand,
} from "./types.js";

export { TESTED_CODEX_VERSION } from "./codex-protocol.js";
export type { CodexProcessFactory } from "./codex-protocol.js";

export interface CodexNativeHarnessAdapterOptions {
  executable?: string;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  now?: () => string;
  /** Injectable process boundary for synthetic fixtures. Production spawns without a shell. */
  processFactory?: CodexProcessFactory;
}

interface PendingApproval {
  id: string;
  requestId: RpcId;
  itemId: string;
  correlationId: string;
  choices: Set<string>;
  details: JsonObject;
  sentDecision?: string;
}

interface ActiveTurn {
  id?: string;
  started: boolean;
  completed: boolean;
  outcome?: NativeHarnessTurnOutcome;
  startCall?: CodexRpcCall;
  interruptCall?: CodexRpcCall;
}

interface Session {
  identity: NativeHarnessSessionIdentity;
  state: NativeHarnessSessionState | "terminal" | "disposed";
  sequence: number;
  listeners: Set<NativeHarnessEventListener>;
  approvals: Map<string, PendingApproval>;
  seenRequests: Set<string>;
  completedItems: Set<string>;
  rpc?: CodexRpc;
  child?: ChildProcessWithoutNullStreams;
  turnId?: string;
  activeTurn?: ActiveTurn;
  completedTurns: Set<string>;
  turnRequested: boolean;
  interruptRequested: boolean;
  permissions?: JsonObject;
  snapshot?: NativeHarnessEvent;
  eventQueue: Array<{ event: NativeHarnessEvent; after?: () => void }>;
  publishing: boolean;
  failure?: CodexError;
  cleanup?: Promise<void>;
}

function rejected(code: NativeHarnessRejectionCode, message: string): NativeHarnessCommandResult<never> {
  return { status: "rejected", code, message };
}

function errorResult(error: CodexError): NativeHarnessCommandResult<never> {
  return { status: "error", code: error.code, message: error.message, nativeDetails: error.details };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodexError("incompatible_codex_protocol", `Codex omitted or changed ${field}.`);
  }
  return value;
}

function record(value: unknown, field: string): JsonObject {
  if (!object(value)) throw new CodexError("incompatible_codex_protocol", `Codex omitted or changed ${field}.`);
  return value;
}

function nativeError(error: JsonObject): CodexError {
  const details = JSON.stringify(error.codexErrorInfo ?? "").toLowerCase();
  const message = typeof error.message === "string" ? error.message : "Codex turn failed.";
  const auth = details.includes("unauthorized") || /"httpstatuscode":401/.test(details) || /\b(unauthenticated|unauthorized|not logged in|authentication required)\b/i.test(message);
  return new CodexError(auth ? "codex_authentication_required" : "codex_turn_failed",
    auth ? "Codex authentication is missing or expired. Run codex login separately, then start a new Ace session." : message,
    { nativeError: error });
}

/** One Ace-created thread with successive explicit turns; session terminal events stay terminal. */
export class CodexNativeHarnessAdapter implements NativeHarnessAdapter {
  readonly adapterId = "codex";
  readonly capabilities: NativeHarnessCapabilities = Object.freeze({
    start: Object.freeze({ supported: true as const }),
    sendInput: Object.freeze({ supported: true as const }),
    observe: Object.freeze({ supported: true as const }),
    interrupt: Object.freeze({ supported: true as const }),
    respondToApproval: Object.freeze({ supported: true as const }),
    resume: Object.freeze({ supported: false as const, reason: "Restart/resume and attaching existing Codex sessions are not implemented." }),
    dispose: Object.freeze({ supported: true as const }),
  });

  private session?: Session;
  private readonly usedSessionIds = new Set<string>();
  private nextApproval = 0;
  private readonly approvalNamespace = randomUUID();
  private readonly options: Required<CodexNativeHarnessAdapterOptions>;

  constructor(options: CodexNativeHarnessAdapterOptions = {}) {
    this.options = {
      executable: options.executable ?? "codex",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1_000,
      now: options.now ?? (() => new Date().toISOString()),
      processFactory: options.processFactory ?? spawnCodex,
    };
    for (const value of [this.options.requestTimeoutMs, this.options.shutdownTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647 / 2) {
        throw new RangeError("Codex timeouts must be positive, bounded integer milliseconds.");
      }
    }
  }

  async start(command: StartSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    if (this.usedSessionIds.has(command.sessionId)) return rejected("duplicate_session", "This local session ID has already been used.");
    if (this.session) return rejected("invalid_state", "Dispose the existing Codex session before starting another.");
    if (!command.sessionId || !isAbsolute(command.workspace)) return rejected("invalid_session", "A session ID and absolute workspace directory are required.");
    // Never forward generic config, approval, sandbox, environment, auth or transport options.
    const nativeOptions = command.nativeOptions ?? {};
    if (!object(nativeOptions) || Object.keys(nativeOptions).some((key) => key !== "model") ||
        ("model" in nativeOptions && (typeof nativeOptions.model !== "string" || !nativeOptions.model.trim()))) {
      return { status: "unsupported", operation: "start", reason: "Only the native model option is supported. Configure authentication and permissions in Codex itself." };
    }
    const model = nativeOptions.model;
    const session: Session = {
      identity: { adapterId: this.adapterId, sessionId: command.sessionId },
      state: "starting", sequence: 0, listeners: new Set(), approvals: new Map(),
      seenRequests: new Set(), completedItems: new Set(), turnRequested: false,
      interruptRequested: false, completedTurns: new Set(), eventQueue: [], publishing: false,
    };
    this.session = session;
    this.usedSessionIds.add(command.sessionId);
    this.state(session, "starting", "initializing", {}, command.correlationId);
    try {
      await checkCodexVersion(this.options.processFactory, this.options.executable, command.workspace,
        this.options.requestTimeoutMs, this.options.shutdownTimeoutMs, (child) => { session.child = child; });
      this.assertOpen(session);
      const child = this.options.processFactory(this.options.executable, ["app-server", "--listen", "stdio://"], command.workspace);
      session.child = child;
      const rpc = new CodexRpc(child, this.options.requestTimeoutMs, this.options.shutdownTimeoutMs,
        (method, params, id) => this.message(session, method, params, id),
        (error) => this.fail(session, error));
      session.rpc = rpc;
      const initialized = await rpc.request("initialize", {
        clientInfo: { name: "aceteam_ace", title: "Ace", version: "0.3.0" },
        capabilities: { experimentalApi: false },
      });
      text(initialized.userAgent, "initialize.userAgent");
      this.assertOpen(session);
      await rpc.send({ method: "initialized", params: {} });
      const account = await rpc.request("account/read", { refreshToken: false });
      if (typeof account.requiresOpenaiAuth !== "boolean" || !(account.account === null ||
          (object(account.account) && ["apiKey", "chatgpt", "amazonBedrock"].includes(String(account.account.type))))) {
        throw new CodexError("incompatible_codex_protocol", "Codex returned an unsupported authentication status.");
      }
      if (account.requiresOpenaiAuth && account.account === null) {
        throw new CodexError("codex_authentication_required", "Codex authentication is required. Run codex login separately, then start a new Ace session.");
      }
      // Account fields and initialize.codexHome are never emitted or retained.
      this.assertOpen(session);
      const started = await rpc.request("thread/start", {
        cwd: command.workspace,
        ...(typeof model === "string" ? { model } : {}),
      });
      this.assertOpen(session);
      session.identity.nativeSessionId = text(record(started.thread, "thread").id, "thread.id");
      if (!(typeof started.approvalPolicy === "string" || object(started.approvalPolicy)) ||
          typeof started.approvalsReviewer !== "string" || !object(started.sandbox)) {
        throw new CodexError("incompatible_codex_protocol", "Codex did not report its effective permission configuration.");
      }
      session.permissions = structuredClone({
        approvalPolicy: started.approvalPolicy, approvalsReviewer: started.approvalsReviewer,
        sandbox: started.sandbox, model: started.model, modelProvider: started.modelProvider,
        cwd: started.cwd, protocol: "v2", codexVersion: TESTED_CODEX_VERSION,
      });
      this.state(session, "ready", "idle", { permissionContext: session.permissions }, command.correlationId);
      this.assertOpen(session);
      return { status: "ok", value: { ...session.identity } };
    } catch (error) {
      const failure = session.failure ?? asCodexError(error);
      this.fail(session, failure);
      await this.cleanup(session);
      session.listeners.clear();
      if (this.session === session) this.session = undefined;
      return errorResult(failure);
    }
  }

  async sendInput(command: SendInputCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const valid = this.validate(command.session);
    if (valid) return valid;
    const session = this.session!;
    if (session.state !== "ready" || session.activeTurn) return rejected("invalid_state", "Input requires a ready session. Steering an active turn is unsupported.");
    if (!command.input.trim()) return rejected("invalid_state", "Input must contain text.");
    const active: ActiveTurn = { started: false, completed: false };
    session.activeTurn = active; // Reserve before awaiting or notifying observers.
    session.turnId = undefined;
    session.turnRequested = true;
    session.interruptRequested = false;
    session.completedItems.clear();
    this.state(session, "running", "turn/start", {}, command.correlationId);
    try {
      this.assertOpen(session);
      active.startCall = session.rpc!.beginRequest("turn/start", {
        threadId: session.identity.nativeSessionId,
        input: [{ type: "text", text: command.input, text_elements: [] }],
      });
      const response = await active.startCall.result;
      if (active.completed) return { status: "ok", value: { accepted: true } };
      this.assertOpen(session);
      const turn = record(response.turn, "turn/start.turn");
      this.bindTurn(session, text(turn.id, "turn.id"));
      if (active.completed) return { status: "ok", value: { accepted: true } };
      this.assertOpen(session);
      if (turn.status === "inProgress") this.state(session, this.runningState(session), "inProgress", { turn });
      else this.finishTurn(session, turn);
      return { status: "ok", value: { accepted: true } };
    } catch (error) {
      if (active.completed) return { status: "ok", value: { accepted: true } };
      const failure = session.failure ?? asCodexError(error);
      this.fail(session, failure);
      return errorResult(failure);
    }
  }

  observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener): NativeHarnessCommandResult<NativeHarnessObservation> {
    const valid = this.validate(command.session);
    if (valid) return valid;
    const session = this.session!;
    session.listeners.add(listener);
    // Expose current effective permissions after asynchronous start; never replay transcript/approvals.
    if (session.snapshot) this.deliver(listener, session.snapshot);
    return { status: "ok", value: { dispose: () => { session.listeners.delete(listener); } } };
  }

  async interrupt(command: InterruptSessionCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const valid = this.validate(command.session);
    if (valid) return valid;
    const session = this.session!;
    const active = session.activeTurn;
    if (this.terminal(session) || !active?.id || active.completed || session.interruptRequested) {
      return rejected("invalid_state", "Interrupt requires a live acknowledged turn and may only be sent once.");
    }
    session.interruptRequested = true;
    this.clearApprovals(session, "interrupted");
    if (active.completed) return rejected("invalid_state", "The turn ended before an interrupt could be submitted.");
    try {
      this.assertOpen(session);
      active.interruptCall = session.rpc!.beginRequest("turn/interrupt", { threadId: session.identity.nativeSessionId, turnId: active.id });
      await active.interruptCall.result;
      if (active.interruptCall.completedFromNative && active.outcome !== "interrupted") {
        return rejected("invalid_state", "The turn ended before Codex acknowledged the interrupt.");
      }
      if (session.failure && !active.completed) throw session.failure;
      // The RPC only acknowledges the request. turn/completed establishes the outcome.
      return { status: "ok", value: { accepted: true } };
    } catch (error) {
      if (active.completed) return active.outcome === "interrupted"
        ? { status: "ok", value: { accepted: true } }
        : rejected("invalid_state", "The turn ended before Codex acknowledged the interrupt.");
      const failure = session.failure ?? asCodexError(error);
      this.fail(session, failure);
      return errorResult(failure);
    }
  }

  async respondToApproval(command: RespondToApprovalCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const valid = this.validate(command.session);
    if (valid) return valid;
    const session = this.session!;
    if (this.terminal(session)) return rejected("invalid_state", "The Codex session has ended.");
    const approval = session.approvals.get(command.approvalId);
    if (!approval || approval.sentDecision) return rejected("stale_approval", "This native request is no longer awaiting a reply.");
    if (command.correlationId !== approval.correlationId) return rejected("approval_mismatch", "The response does not match this live native approval.");
    if (!approval.choices.has(command.decision)) return rejected("invalid_approval_decision", "Choose one of the offered native decisions.");
    approval.sentDecision = command.decision; // Claim before write to reject concurrent replies.
    try {
      await session.rpc!.send({ id: approval.requestId, result: { decision: command.decision } });
      if (session.failure) throw session.failure;
      // Native serverRequest/resolved or item/completed clears the UI prompt.
      return { status: "ok", value: { accepted: true } };
    } catch (error) {
      const failure = session.failure ?? asCodexError(error);
      this.fail(session, failure);
      return errorResult(failure);
    }
  }

  async resume(_command: ResumeSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    return { status: "unsupported", operation: "resume", reason: "Only new Ace-created Codex sessions are supported; restart/resume is a later slice." };
  }

  async dispose(command: DisposeSessionCommand): Promise<NativeHarnessCommandResult<SessionDisposed>> {
    const valid = this.validate(command.session);
    if (valid) return valid;
    const session = this.session!;
    session.state = "disposed";
    session.approvals.clear();
    session.listeners.clear();
    await this.cleanup(session);
    if (this.session === session) this.session = undefined;
    return { status: "ok", value: { disposed: true } };
  }

  private validate(identity: NativeHarnessSessionIdentity): NativeHarnessCommandResult<never> | undefined {
    if (identity.adapterId !== this.adapterId) return rejected("adapter_mismatch", "The session belongs to another adapter.");
    if (!this.session || identity.sessionId !== this.session.identity.sessionId ||
        identity.nativeSessionId !== this.session.identity.nativeSessionId || this.session.state === "disposed") {
      return rejected("invalid_session", "The session identity is not owned by this adapter.");
    }
  }

  private assertOpen(session: Session): void {
    if (this.terminal(session)) throw session.failure ?? new CodexError("codex_disconnected", "The Codex session closed during startup.");
  }

  private terminal(session: Session): boolean { return session.state === "terminal" || this.isDisposed(session); }
  private isDisposed(session: Session): boolean { return session.state === "disposed"; }

  private cleanup(session: Session): Promise<void> {
    session.cleanup ??= session.rpc?.close() ?? (session.child ? stopChild(session.child, this.options.shutdownTimeoutMs) : Promise.resolve());
    return session.cleanup;
  }

  private fail(session: Session, error: CodexError): void {
    if (this.terminal(session)) return;
    session.failure = error;
    session.state = "terminal";
    this.clearApprovals(session, "session_error");
    this.publish(session, { type: "session.error", error: { code: error.code, message: error.message, retryable: false, nativeDetails: error.details } });
    void this.cleanup(session);
  }

  private publish(session: Session, payload: NativeHarnessEventPayload, correlationId = session.turnId, after?: () => void): void {
    if (this.isDisposed(session)) return;
    const event: NativeHarnessEvent = { nativeTurnId: session.turnId, ...payload, ...session.identity, correlationId, sequence: ++session.sequence, timestamp: this.options.now() };
    session.eventQueue.push({ event: structuredClone(event), after });
    if (session.publishing) return;
    session.publishing = true;
    try {
      while (session.eventQueue.length && !this.isDisposed(session)) {
        const queued = session.eventQueue.shift()!;
        const next = queued.event;
        if (next.type.startsWith("session.")) session.snapshot = structuredClone(next);
        for (const listener of [...session.listeners]) {
          if (this.isDisposed(session)) break;
          if (session.listeners.has(listener)) this.deliver(listener, next);
        }
        if (!this.isDisposed(session)) queued.after?.();
      }
    } finally {
      session.publishing = false;
      session.eventQueue.length = 0;
    }
  }

  private deliver(listener: NativeHarnessEventListener, event: NativeHarnessEvent): void {
    // Presentation cannot mutate protocol state or prevent other observers receiving events.
    try { listener(structuredClone(event)); } catch { /* Observer owns rendering failures. */ }
  }

  private state(session: Session, state: NativeHarnessSessionState, nativeState: string, details: JsonObject, correlationId?: string): void {
    if (this.terminal(session)) return;
    session.state = state;
    this.publish(session, { type: "session.state", state, nativeState, nativeDetails: { permissionContext: session.permissions, ...details } }, correlationId ?? session.turnId);
  }

  private runningState(session: Session): NativeHarnessSessionState {
    return session.approvals.size ? "waiting_for_approval" : session.turnRequested ? "running" : "ready";
  }

  private message(session: Session, method: string, params: JsonObject, requestId?: RpcId): void {
    if (this.terminal(session)) return;
    if (requestId !== undefined) {
      // A delayed old-turn request must never become a fresh UI prompt.
      if (typeof params.turnId === "string" && session.completedTurns.has(params.turnId)) {
        void session.rpc!.send({ id: requestId, error: { code: -32602, message: "The requested turn has ended." } }).catch(() => {});
        return;
      }
      this.approval(session, method, params, requestId); return;
    }
    // Do not subscribe to or import arbitrary sessions (including observed workers).
    if (params.threadId !== undefined && params.threadId !== session.identity.nativeSessionId) return;
    if (method.startsWith("account/")) return; // Native auth remains opaque to Ace.
    if (method === "thread/started") return; // Bind identity only from our response.
    if (!session.identity.nativeSessionId) return;
    if (params.turnId !== undefined) {
      const turnId = text(params.turnId, "turnId");
      if (session.completedTurns.has(turnId)) return;
      if (session.turnId && session.turnId !== turnId) return;
      this.bindTurn(session, turnId);
      if (this.terminal(session) || session.completedTurns.has(turnId)) return;
    }
    const details = { method, params };
    switch (method) {
      case "turn/started": {
        const turn = record(params.turn, "turn/started.turn");
        const turnId = text(turn.id, "turn.id");
        if (session.completedTurns.has(turnId)) return;
        if (params.threadId !== session.identity.nativeSessionId) throw new CodexError("incompatible_codex_protocol", "Codex omitted the thread ID.");
        if (turn.status !== "inProgress") throw new CodexError("incompatible_codex_protocol", "Unsupported started turn status.", details);
        this.bindTurn(session, turnId);
        if (this.terminal(session) || session.completedTurns.has(turnId)) return;
        this.state(session, this.runningState(session), "inProgress", details);
        return;
      }
      case "turn/completed": {
        const turn = record(params.turn, "turn/completed.turn");
        const turnId = text(turn.id, "turn.id");
        if (session.completedTurns.has(turnId)) return;
        if (params.threadId !== session.identity.nativeSessionId) throw new CodexError("incompatible_codex_protocol", "Codex omitted the thread ID.");
        this.bindTurn(session, turnId);
        if (this.terminal(session) || session.completedTurns.has(turnId)) return;
        this.finishTurn(session, turn);
        return;
      }
      case "serverRequest/resolved": {
        if (params.threadId !== session.identity.nativeSessionId || !rpcId(params.requestId)) throw new CodexError("incompatible_codex_protocol", "Invalid native approval resolution.");
        for (const approval of session.approvals.values()) {
          if (approval.requestId === params.requestId) this.resolveApproval(session, approval, "native_resolved");
        }
        this.state(session, this.runningState(session), "serverRequest/resolved", details);
        return;
      }
      case "thread/closed":
        throw new CodexError("codex_disconnected", "Codex closed the native thread before completion.", details);
      case "thread/status/changed": {
        const status = record(params.status, "thread.status");
        const nativeState = text(status.type, "thread.status.type");
        if (!["idle", "active"].includes(nativeState)) throw new CodexError("incompatible_codex_protocol", "Codex reported an unavailable or unknown thread state.", details);
        this.state(session, this.runningState(session), nativeState, details);
        return;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        this.requireTurn(session, params);
        if (typeof params.delta !== "string") throw new CodexError("incompatible_codex_protocol", "Invalid Codex text delta.");
        this.publish(session, { type: "conversation.delta", role: "assistant", text: params.delta, nativeMessageId: text(params.itemId, "itemId"), nativeDetails: details });
        return;
      }
      case "item/started":
      case "item/completed":
        this.requireTurn(session, params);
        this.item(session, record(params.item, "item"), method === "item/completed", details);
        return;
      case "turn/diff/updated":
        this.requireTurn(session, params);
        if (typeof params.diff !== "string") throw new CodexError("incompatible_codex_protocol", "Invalid Codex diff.");
        this.publish(session, { type: "change.reported", changeId: session.turnId!, nativeChangeId: session.turnId, files: [], nativeDetails: details });
        return;
      case "error": {
        this.requireTurn(session, params);
        const error = record(params.error, "error");
        if (typeof params.willRetry !== "boolean") throw new CodexError("incompatible_codex_protocol", "Codex did not report whether its error is terminal.", details);
        if (params.willRetry) this.state(session, this.runningState(session), "retrying", details);
        else {
          const failure = nativeError(error);
          this.state(session, this.runningState(session), "turn_failed", { ...details, error: { code: failure.code, message: failure.message, nativeDetails: failure.details } });
        }
        return;
      }
      default:
        // Preserve unknown notifications/extensions without interpreting them as success.
        this.state(session, this.runningState(session), method, details);
    }
  }

  private requireTurn(session: Session, params: JsonObject): void {
    if (!session.turnRequested || !session.turnId || params.threadId !== session.identity.nativeSessionId || params.turnId !== session.turnId) throw new CodexError("incompatible_codex_protocol", "Codex omitted the active thread/turn correlation.");
  }

  private bindTurn(session: Session, turnId: string): void {
    const active = session.activeTurn;
    if (!active || active.completed || session.completedTurns.has(turnId) || (active.id && active.id !== turnId)) {
      throw new CodexError("incompatible_codex_protocol", "Codex reported an unrecognized or reused turn ID.");
    }
    active.id = turnId;
    session.turnId = turnId;
    if (!active.started) {
      active.started = true;
      this.publish(session, { type: "turn.started", nativeTurnId: turnId });
    }
  }

  private finishTurn(session: Session, turn: JsonObject): void {
    const active = session.activeTurn;
    if (!active || active.completed || active.id !== turn.id) throw new CodexError("incompatible_codex_protocol", "Codex completed an unrecognized turn.");
    const status = text(turn.status, "turn.status");
    if (status !== "completed" && status !== "interrupted" && status !== "failed") throw new CodexError("incompatible_codex_protocol", "Unsupported terminal Codex turn status.", { turn });
    const failure = status === "failed" ? nativeError(record(turn.error, "turn.error")) : undefined;
    const nativeTurnId = text(active.id, "active turn ID");
    active.completed = true;
    active.outcome = status;
    session.completedTurns.add(nativeTurnId);
    // Native completion proves these commands' outcomes even before their RPC responses.
    active.startCall?.completeFromNative({ turn });
    active.interruptCall?.completeFromNative({});
    this.clearApprovals(session, "turn_ended");
    if (this.terminal(session)) return;
    this.publish(session, {
      type: "turn.completed", nativeTurnId, outcome: status, result: turn,
      error: failure ? { code: failure.code, message: failure.message, retryable: false, nativeDetails: failure.details } : undefined,
      nativeState: status, nativeDetails: { turn },
    }, nativeTurnId, () => {
      if (this.terminal(session) || session.activeTurn !== active) return;
      session.activeTurn = undefined;
      session.turnRequested = false;
      session.turnId = undefined;
      session.interruptRequested = false;
      this.state(session, "ready", "idle", { completedTurnId: nativeTurnId }, nativeTurnId);
    });
  }

  private approval(session: Session, method: string, params: JsonObject, requestId: RpcId): void {
    const supported = method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
    if (!supported) {
      // Explicit protocol error, never a guessed denial or grant of a different operation.
      void session.rpc!.send({ id: requestId, error: { code: -32601, message: "Ace supports command and file approvals only." } }).finally(() => {
        this.fail(session, new CodexError("unsupported_codex_request", `Unsupported native request: ${method}. Use a compatible Codex client for this interaction.`, { method }));
      }).catch(() => {});
      return;
    }
    this.requireTurn(session, params);
    const requestKey = JSON.stringify(requestId);
    const itemId = text(params.itemId, "approval.itemId");
    if (session.interruptRequested || session.seenRequests.has(requestKey) || session.completedItems.has(itemId)) throw new CodexError("codex_stale_request", "Codex sent a duplicate or expired approval request.");
    session.seenRequests.add(requestKey);
    // Session grants/policy amendments are unavailable in this slice. Preserve full context.
    let choices = ["accept", "decline", "cancel"];
    if (params.availableDecisions !== undefined && params.availableDecisions !== null) {
      if (!Array.isArray(params.availableDecisions)) throw new CodexError("incompatible_codex_protocol", "Invalid native approval choices.");
      choices = choices.filter((choice) => (params.availableDecisions as unknown[]).includes(choice));
    }
    if (!choices.length) throw new CodexError("unsupported_codex_request", "Codex offered no supported single-action approval decision.", { method, params });
    const approval: PendingApproval = {
      id: `codex-approval-${this.approvalNamespace}-${++this.nextApproval}`, requestId, itemId,
      correlationId: `codex-request:${JSON.stringify([session.identity.sessionId, session.identity.nativeSessionId, session.turnId, requestId])}`, choices: new Set(choices),
      details: structuredClone({ method, params, requestId, permissionContext: session.permissions }),
    };
    session.approvals.set(approval.id, approval);
    this.state(session, "waiting_for_approval", method, { permissionContext: session.permissions });
    if (this.terminal(session) || !session.approvals.has(approval.id)) return;
    const network = object(params.networkApprovalContext) ? params.networkApprovalContext : undefined;
    const prompt = network ? `Codex requests network access: ${String(network.host ?? "unknown host")} (${String(network.protocol ?? "unknown protocol")}).`
      : method === "item/fileChange/requestApproval" ? "Codex requests approval for file changes."
      : `Codex requests command approval${typeof params.command === "string" ? `: ${params.command}` : "."}`;
    this.publish(session, { type: "approval.requested", approvalId: approval.id, nativeApprovalId: String(requestId),
      choices, prompt: typeof params.reason === "string" ? `${prompt}\n${params.reason}` : prompt, nativeDetails: approval.details,
    }, approval.correlationId);
  }

  private resolveApproval(session: Session, approval: PendingApproval, reason: string): void {
    session.approvals.delete(approval.id);
    this.publish(session, { type: "approval.resolved", approvalId: approval.id,
      nativeApprovalId: String(approval.requestId), decision: approval.sentDecision ?? "expired",
      nativeDetails: { ...approval.details, resolution: reason, decisionSubmitted: approval.sentDecision !== undefined },
    }, approval.correlationId);
  }

  private clearApprovals(session: Session, reason: string): void {
    const approvals = [...session.approvals.values()];
    session.approvals.clear();
    for (const approval of approvals) this.resolveApproval(session, approval, reason);
  }

  private item(session: Session, item: JsonObject, completed: boolean, details: JsonObject): void {
    const id = text(item.id, "item.id");
    const type = text(item.type, "item.type");
    if (completed) {
      if (session.completedItems.has(id)) return;
      session.completedItems.add(id);
      const pendingBefore = session.approvals.size;
      for (const approval of session.approvals.values()) {
        if (approval.itemId === id) this.resolveApproval(session, approval, "item_completed");
      }
      if (session.approvals.size !== pendingBefore) this.state(session, this.runningState(session), "item/completed", details);
      if (this.terminal(session)) return;
    }
    if (type === "agentMessage" || type === "plan") {
      if (completed) {
        if (typeof item.text !== "string") throw new CodexError("incompatible_codex_protocol", "Invalid Codex message text.");
        this.publish(session, { type: "conversation.message", role: "assistant", text: item.text, nativeMessageId: id, nativeDetails: details });
      }
      return;
    }
    if (type === "userMessage") {
      if (completed) {
        if (!Array.isArray(item.content)) throw new CodexError("incompatible_codex_protocol", "Invalid Codex user content.");
        const content = item.content.filter((part) => object(part) && part.type === "text" && typeof part.text === "string");
        this.publish(session, { type: "conversation.message", role: "user", text: content.map((part) => part.text).join("\n"), nativeMessageId: id, nativeDetails: details });
      }
      return;
    }
    if (["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall", "webSearch", "imageView"].includes(type)) {
      const nativeState = ["webSearch", "imageView"].includes(type)
        ? completed ? "completed" : "inProgress"
        : text(item.status, "item.status");
      if (!(type === "collabAgentToolCall" ? ["inProgress", "completed", "failed", "interrupted"] : ["inProgress", "completed", "failed", "declined"]).includes(nativeState) || (completed && nativeState === "inProgress")) throw new CodexError("incompatible_codex_protocol", "Unsupported native tool status.", details);
      const failed = nativeState === "failed" || nativeState === "declined" || nativeState === "interrupted" || (type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);
      this.publish(session, { type: "tool.activity", toolCallId: id, nativeToolCallId: id,
        name: type === "mcpToolCall" ? `${String(item.server)}.${String(item.tool)}` : type,
        state: failed ? "failed" : completed ? "completed" : "started", nativeState,
        input: item.command ?? item.arguments, output: item.aggregatedOutput ?? item.result ?? item.error, nativeDetails: details });
      if (this.terminal(session)) return;
      if (type === "fileChange" && completed && !failed) {
        if (!Array.isArray(item.changes)) throw new CodexError("incompatible_codex_protocol", "Invalid Codex file changes.");
        const files = item.changes.map((entry) => {
          const change = record(entry, "change");
          const kind = record(change.kind, "change.kind");
          return { path: text(change.path, "change.path"), kind: kind.type === "add" ? "added" as const : kind.type === "delete" ? "deleted" as const : kind.type === "update" ? typeof kind.move_path === "string" ? "renamed" as const : "modified" as const : "unknown" as const };
        });
        this.publish(session, { type: "change.reported", changeId: id, nativeChangeId: id, files, nativeDetails: details });
      }
      if (type === "collabAgentToolCall" && object(item.agentsStates)) {
        for (const [workerId, value] of Object.entries(item.agentsStates)) {
          const worker = record(value, "worker");
          const workerState = text(worker.status, "worker.status");
          const states = { pendingInit: "started", running: "running", completed: "completed", interrupted: "failed", errored: "failed", notFound: "failed" } as const;
          if (!Object.hasOwn(states, workerState)) { this.state(session, this.runningState(session), workerState, details); continue; }
          this.publish(session, { type: "worker.status", workerId, nativeWorkerId: workerId,
            state: states[workerState as keyof typeof states], nativeState: workerState,
            label: typeof item.tool === "string" ? item.tool : undefined, nativeDetails: { ...details, worker } });
        }
      }
      return;
    }
    this.state(session, this.runningState(session), type, details);
  }
}
