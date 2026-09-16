import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { ClaudeInputQueue } from "./claude-input-queue.js";
import {
  loadClaudeSdk, TESTED_CLAUDE_CODE_VERSION, type ClaudeQuery,
  type ClaudeSdkBoundary, type ClaudeSdkFactory, type ClaudeSdkMessage, type ClaudeSdkUserMessage,
} from "./claude-sdk.js";
import {
  NativeSessionStore, SessionStoreError, captureWorkspaceIdentity, sameWorkspace,
  type NativeSessionRecord, type WorkspaceIdentity,
} from "./session-store.js";
import type {
  CommandAccepted, DeliverExternalOutputCommand, DisposeSessionCommand, InterruptSessionCommand,
  NativeHarnessAdapter, NativeHarnessCapabilities, NativeHarnessCommandResult,
  NativeHarnessEvent, NativeHarnessEventListener, NativeHarnessEventPayload,
  NativeHarnessObservation, NativeHarnessRejectionCode, NativeHarnessSessionIdentity, NativeExternalOutputResult,
  NativeHarnessSessionState, NativeHarnessTurnOutcome, ObserveSessionCommand,
  RespondToApprovalCommand, ResumeSessionCommand, SendInputCommand, SessionDisposed,
  StartSessionCommand,
} from "./types.js";

export { TESTED_CLAUDE_AGENT_SDK_VERSION, TESTED_CLAUDE_CODE_VERSION } from "./claude-sdk.js";
export type { ClaudeSdkBoundary, ClaudeSdkFactory } from "./claude-sdk.js";

type Environment = Record<string, string | undefined>;
type ConfirmationHook = (identity: NativeHarnessSessionIdentity) => Promise<void>;

export interface ClaudeNativeHarnessAdapterOptions {
  sessionStore?: Pick<NativeSessionStore, "resolveForResume">;
  onNativeSessionConfirmed?: ConfirmationHook;
  /** Synthetic fixture boundary. Production lazily imports the pinned SDK. */
  sdkFactory?: ClaudeSdkFactory;
  environment?: Environment;
  createId?: () => string;
  now?: () => string;
  cleanupTimeoutMs?: number;
  initializationTimeoutMs?: number;
  inputAckTimeoutMs?: number;
  reconciliationTimeoutMs?: number;
}

interface PendingApproval {
  id: string;
  key: string;
  correlationId: string;
  turnId: string;
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (answer: { behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID: string } |
    { behavior: "deny"; message: string; toolUseID: string }) => void;
  promise: Promise<{ behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID: string } |
    { behavior: "deny"; message: string; toolUseID: string }>;
  resolved?: string;
}

interface ToolState { id: string; name: string; turnId: string; completed: boolean }
interface TurnState {
  id: string;
  acknowledged: boolean;
  result?: Record<string, unknown>;
  idle: boolean;
  interruptRequested: boolean;
  completed: boolean;
  acknowledge: (accepted: boolean) => void;
  accepted: Promise<boolean>;
  reconciliation?: ReturnType<typeof setTimeout>;
}

interface Session {
  identity: NativeHarnessSessionIdentity;
  proposedNativeId: string;
  workspace: WorkspaceIdentity;
  state: NativeHarnessSessionState | "terminal" | "disposed";
  sequence: number;
  listeners: Set<NativeHarnessEventListener>;
  snapshot?: NativeHarnessEvent;
  queue: ClaudeInputQueue<ClaudeSdkUserMessage>;
  query: ClaudeQuery;
  abortController: AbortController;
  reader?: Promise<void>;
  cleanup?: Promise<boolean>;
  active?: TurnState;
  approvals: Map<string, PendingApproval>;
  approvalsByKey: Map<string, PendingApproval>;
  seenApprovalKeys: Set<string>;
  tools: Map<string, ToolState>;
  workers: Set<string>;
  reportedDenials: Set<string>;
  confirmed: boolean;
  resuming: boolean;
  permissionMode?: string;
  expectedPermissionMode: "default" | "plan" | "dontAsk";
  confirmation: Promise<void>;
  confirmResolve: () => void;
  confirmReject: (error: Error) => void;
  failure?: ClaudeAdapterError;
  eventQueue: NativeHarnessEvent[];
  publishing: boolean;
  streamApiMessageIds: Map<string, { id: string; turnId: string }>;
  completedBlockCounts: Map<string, number>;
  seenNativeFrameIds: Set<string>;
}

interface Opening {
  sessionId: string;
  cancelled: boolean;
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
}

class ClaudeAdapterError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ClaudeAdapterError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rejected(code: NativeHarnessRejectionCode, message: string): NativeHarnessCommandResult<never> {
  return { status: "rejected", code, message };
}

function resultError(error: unknown): NativeHarnessCommandResult<never> {
  const failure = error instanceof ClaudeAdapterError ? error : error instanceof SessionStoreError
    ? new ClaudeAdapterError("session_state_" + error.code, error.message)
    : new ClaudeAdapterError("claude_adapter_error", error instanceof Error ? error.message : "Claude Agent failed.");
  return { status: "error", code: failure.code, message: failure.message, nativeDetails: failure.details };
}

function validTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647 / 2) {
    throw new RangeError(name + " must be a positive, bounded integer number of milliseconds.");
  }
  return value;
}

function routeEnvironment(environment: Environment): Environment {
  if (!environment.ANTHROPIC_API_KEY?.trim()) {
    throw new ClaudeAdapterError("claude_authentication_required", "Claude Agent requires ANTHROPIC_API_KEY in the environment.");
  }
  const conflicting = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
    .find((name) => environment[name]?.trim());
  const cloud = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]
    .find((name) => /^(1|true|yes)$/i.test(environment[name]?.trim() ?? ""));
  if (conflicting || cloud) {
    throw new ClaudeAdapterError("claude_authentication_route_unsupported",
      "Claude Agent currently supports first-party ANTHROPIC_API_KEY authentication only. Remove conflicting OAuth, bearer, or cloud-provider route settings.");
  }
  return { ...environment };
}

function nativeOptions(value: unknown, resuming: boolean): { model?: string } {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).some((key) => key !== "model") ||
      ("model" in value && !text(value.model)?.trim())) {
    throw new ClaudeAdapterError("claude_options_unsupported",
      "Only the native model option is supported for a new Claude Agent session. Configure authentication and permissions in Claude settings.");
  }
  if (resuming && Object.keys(value).length) {
    throw new ClaudeAdapterError("claude_resume_options_unsupported", "Claude Agent resume uses the saved native session configuration and accepts no overrides.");
  }
  return typeof value.model === "string" ? { model: value.model } : {};
}

function supportedPermissionMode(value: unknown): value is "default" | "plan" | "dontAsk" {
  return value === "default" || value === "plan" || value === "dontAsk";
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasPolicyHelper(resolved: { effective: Record<string, unknown>; sources: Array<{ source: string; settings: Record<string, unknown>; policyOrigin?: string }>; [key: string]: unknown }): boolean {
  if (own(resolved.effective, "policyHelper") || own(resolved.effective, "policyHelpers")) return true;
  if (resolved.sources.some((source) => source.source === "managed" &&
      (own(source.settings, "policyHelper") || own(source.settings, "policyHelpers") || source.policyOrigin === "helper"))) return true;
  const provenance = object(resolved.provenance) ? resolved.provenance : {};
  return Object.values(provenance).some((entry) => object(entry) && entry.policyOrigin === "helper");
}

function messageSessionId(message: Record<string, unknown>): string | undefined {
  return text(message.session_id);
}

function correlations(message: Record<string, unknown>): string[] {
  const values = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids.filter((value): value is string => typeof value === "string") : [];
  const single = text(message.user_message_uuid);
  return single && !values.includes(single) ? [...values, single] : values;
}

function bounded<T>(operation: Promise<T>, milliseconds: number, timeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { resolve(timeout()); } catch (error) { reject(error); }
    }, milliseconds);
    timer.unref?.();
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function activeCompleted(session: Session, id: string): boolean {
  return session.active?.id === id && session.active.completed;
}

function terminalOutcome(result: Record<string, unknown>): NativeHarnessTurnOutcome {
  const terminal = text(result.terminal_reason);
  if (terminal === "aborted_streaming" || terminal === "aborted_tools") return "interrupted";
  return result.subtype === "success" && result.is_error === false && (!terminal || terminal === "completed") ? "completed" : "failed";
}

function safeResult(result: Record<string, unknown>): Record<string, unknown> {
  const permissionDenials = Array.isArray(result.permission_denials) ? result.permission_denials.flatMap((value) => {
    if (!object(value) || !text(value.tool_name) || !text(value.tool_use_id)) return [];
    return [{ toolName: value.tool_name, toolUseId: value.tool_use_id,
      toolInput: safeToolInput(String(value.tool_name), value.tool_input) }];
  }) : [];
  return {
    subtype: result.subtype,
    isError: result.is_error,
    stopReason: result.stop_reason,
    terminalReason: result.terminal_reason,
    resultUuid: result.uuid,
    userMessageUuid: result.user_message_uuid,
    userMessageUuids: result.user_message_uuids,
    permissionDenials,
    ...(Array.isArray(result.errors) ? { errors: result.errors.filter((value): value is string => typeof value === "string") } : {}),
  };
}

function safeToolInput(name: string, input: unknown): unknown {
  if ((name === "Edit" || name === "Write") && object(input)) {
    return { filePath: input.file_path ?? input.filePath };
  }
  return input;
}

/** A single owned Claude query with an explicit input queue and delayed native identity. */
export class ClaudeNativeHarnessAdapter implements NativeHarnessAdapter {
  readonly adapterId = "claude";
  readonly capabilities: NativeHarnessCapabilities = Object.freeze({
    start: Object.freeze({ supported: true as const }), sendInput: Object.freeze({ supported: true as const }),
    deliverExternalOutput: Object.freeze({ supported: false as const, reason: "Claude external intake requires a separately validated native capability." }),
    observe: Object.freeze({ supported: true as const }), interrupt: Object.freeze({ supported: true as const }),
    respondToApproval: Object.freeze({ supported: true as const }), resume: Object.freeze({ supported: true as const }),
    dispose: Object.freeze({ supported: true as const }),
  });

  private session?: Session;
  private opening?: Opening;
  private readonly usedSessionIds = new Set<string>();
  private readonly sessionStore: Pick<NativeSessionStore, "resolveForResume">;
  private readonly onNativeSessionConfirmed: ConfirmationHook;
  private readonly sdkFactory: ClaudeSdkFactory;
  private readonly environment?: Environment;
  private readonly createId: () => string;
  private readonly now: () => string;
  private readonly cleanupTimeoutMs: number;
  private readonly initializationTimeoutMs: number;
  private readonly inputAckTimeoutMs: number;
  private readonly reconciliationTimeoutMs: number;

  constructor(options: ClaudeNativeHarnessAdapterOptions = {}) {
    if (options.environment && !options.sdkFactory) {
      throw new Error("A custom Claude environment is available only with an injected SDK boundary for synthetic tests.");
    }
    this.sessionStore = options.sessionStore ?? new NativeSessionStore();
    this.onNativeSessionConfirmed = options.onNativeSessionConfirmed ?? (async () => {});
    this.sdkFactory = options.sdkFactory ?? loadClaudeSdk;
    this.environment = options.environment && { ...options.environment };
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.cleanupTimeoutMs = validTimeout(options.cleanupTimeoutMs ?? 2_000, "Claude cleanup timeout");
    this.initializationTimeoutMs = validTimeout(options.initializationTimeoutMs ?? 15_000, "Claude initialization timeout");
    this.inputAckTimeoutMs = validTimeout(options.inputAckTimeoutMs ?? 30_000, "Claude input acknowledgement timeout");
    this.reconciliationTimeoutMs = validTimeout(options.reconciliationTimeoutMs ?? 2_000, "Claude reconciliation timeout");
  }

  start(command: StartSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    return this.open(command);
  }

  resume(command: ResumeSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    return this.open(command);
  }

  private async open(command: StartSessionCommand | ResumeSessionCommand): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>> {
    const resuming = command.type === "session.resume";
    if (this.session || this.opening) return rejected("invalid_state", "Dispose the existing Claude Agent session before opening another.");
    if (this.usedSessionIds.has(command.sessionId)) return rejected("duplicate_session", "This local session ID has already been used.");
    if (!command.sessionId || !isAbsolute(command.workspace)) return rejected("invalid_session", "A session ID and absolute workspace directory are required.");
    if (resuming && (!command.registeredSessionId || !command.nativeSessionId || command.registeredSessionId === command.sessionId)) {
      return rejected("invalid_session", "Resume requires a saved Claude Agent registration and a fresh local session ID.");
    }
    let selected: { model?: string };
    try { selected = nativeOptions(command.nativeOptions, resuming); }
    catch (error) {
      const mapped = resultError(error);
      return mapped.status === "error" ? { status: "unsupported", operation: resuming ? "resume" : "start", reason: mapped.message } : mapped;
    }
    let environment: Environment;
    try { environment = routeEnvironment(this.environment ?? process.env); }
    catch (error) { return resultError(error); }
    let settle!: () => void;
    const opening: Opening = { sessionId: command.sessionId, cancelled: false, controller: new AbortController(),
      settled: new Promise<void>((resolve) => { settle = resolve; }), settle: () => settle() };
    this.opening = opening;
    this.usedSessionIds.add(command.sessionId);
    let session: Session | undefined;
    try {
      const workspace = await this.duringOpen(opening, captureWorkspaceIdentity(command.workspace));
      let registration: NativeSessionRecord | undefined;
      const proposedNativeId = resuming ? command.nativeSessionId : this.createId();
      if (resuming) {
        registration = await this.duringOpen(opening, this.sessionStore.resolveForResume({
          adapterId: this.adapterId, sessionId: command.registeredSessionId!, workspace: workspace.realPath,
        }));
        if (registration.nativeSessionId !== command.nativeSessionId || !sameWorkspace(registration.workspace, workspace)) {
          throw new ClaudeAdapterError("claude_resume_identity_mismatch", "The saved Claude Agent session does not match this workspace and native session.");
        }
      }
      const sdk = await this.duringOpen(opening, this.sdkFactory());
      if (registration) {
        const info = await this.duringOpen(opening, sdk.getSessionInfo(proposedNativeId, { dir: workspace.realPath }));
        if (!info || info.sessionId !== proposedNativeId || !text(info.cwd)) {
          throw new ClaudeAdapterError("claude_resume_unavailable", "Claude Agent could not verify the saved native session. Restore its native history or start a new session.");
        }
        const infoWorkspace = await this.duringOpen(opening, captureWorkspaceIdentity(String(info.cwd)));
        if (!sameWorkspace(infoWorkspace, workspace)) throw new ClaudeAdapterError("claude_resume_workspace_mismatch", "Claude Agent reported this session in a different workspace.");
      }
      let resolved;
      try {
        resolved = await this.duringOpen(opening, sdk.resolveSettings({ cwd: workspace.realPath, settingSources: ["user", "project", "local"] }));
      } catch {
        throw new ClaudeAdapterError("claude_settings_resolution_failed", "Claude Agent settings could not be resolved safely. Fix native settings before opening this session.");
      }
      if (hasPolicyHelper(resolved)) {
        throw new ClaudeAdapterError("claude_policy_helper_unsupported", "Claude Agent policyHelper is configured, but this adapter cannot execute it during permission resolution.");
      }
      let filtered: Record<string, unknown>;
      try { filtered = sdk.filterEscalatingDefaultMode(resolved); }
      catch { throw new ClaudeAdapterError("claude_settings_resolution_failed", "Claude Agent settings could not be filtered safely."); }
      const permissions = object(filtered.permissions) ? filtered.permissions : {};
      const permissionMode = permissions.defaultMode ?? "default";
      if (!supportedPermissionMode(permissionMode)) {
        throw new ClaudeAdapterError("claude_permission_mode_unsupported", "Claude Agent permission mode " + String(permissionMode) + " is unsupported. Use default, plan, or dontAsk.");
      }
      let confirmResolve!: () => void;
      let confirmReject!: (error: Error) => void;
      const confirmation = new Promise<void>((resolve, reject) => { confirmResolve = resolve; confirmReject = reject; });
      void confirmation.catch(() => {});
      const queue = new ClaudeInputQueue<ClaudeSdkUserMessage>();
      const abortController = new AbortController();
      const query = sdk.query({ prompt: queue, options: {
        cwd: workspace.realPath, abortController, env: environment,
        settingSources: ["user", "project", "local"], includePartialMessages: true,
        canUseTool: (toolName, input, details) => this.permissionCallback(session!, toolName, input, details),
        agentProgressSummaries: false, promptSuggestions: false, permissionMode,
        ...(resuming ? { resume: proposedNativeId } : { sessionId: proposedNativeId, ...selected }),
      } });
      session = {
        identity: { adapterId: this.adapterId, sessionId: command.sessionId, ...(resuming ? { nativeSessionId: proposedNativeId } : {}) },
        proposedNativeId, workspace, state: "starting", sequence: 0, listeners: new Set(), queue, query,
        abortController, approvals: new Map(), approvalsByKey: new Map(), seenApprovalKeys: new Set(), tools: new Map(), workers: new Set(), reportedDenials: new Set(),
        confirmed: false, resuming, expectedPermissionMode: permissionMode, confirmation, confirmResolve, confirmReject,
        eventQueue: [], publishing: false, streamApiMessageIds: new Map(), completedBlockCounts: new Map(), seenNativeFrameIds: new Set(),
      };
      this.session = session;
      const initialized = await this.duringOpen(opening, bounded(query.initializationResult(), this.initializationTimeoutMs, () => {
        throw new ClaudeAdapterError("claude_initialization_timeout", "Claude Agent did not initialize before the bounded startup deadline.");
      }));
      if (initialized.account?.apiKeySource !== "ANTHROPIC_API_KEY" || initialized.account.apiProvider !== "firstParty") {
        throw new ClaudeAdapterError("claude_authentication_route_unsupported", "Claude Agent did not confirm first-party ANTHROPIC_API_KEY authentication. Check native environment and settings.");
      }
      this.assertOpen(session);
      this.state(session, "ready", "initialized_awaiting_native_identity", { permissionContext: { permissionMode: "awaiting_native_confirmation", rulesMayResolveBeforeCallback: true } }, command.correlationId);
      session.reader = this.read(session);
      return { status: "ok", value: { ...session.identity } };
    } catch (error) {
      if (session) {
        this.fail(session, error);
        const clean = await this.cleanup(session);
        if (clean && this.session === session) this.session = undefined;
      }
      return resultError(error);
    } finally {
      opening.settle();
      if (this.opening === opening) this.opening = undefined;
    }
  }

  private async duringOpen<T>(opening: Opening, operation: Promise<T>): Promise<T> {
    if (opening.cancelled) throw new ClaudeAdapterError("claude_open_cancelled", "Claude Agent startup was cancelled.");
    return Promise.race([operation, new Promise<never>((_, reject) => {
      const abort = () => reject(new ClaudeAdapterError("claude_open_cancelled", "Claude Agent startup was cancelled."));
      opening.controller.signal.addEventListener("abort", abort, { once: true });
      operation.finally(() => opening.controller.signal.removeEventListener("abort", abort)).catch(() => {});
    })]);
  }

  async sendInput(command: SendInputCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const valid = this.validate(command.session); if (valid) return valid;
    const session = this.session!;
    if (session.state !== "ready" || session.active) return rejected("invalid_state", "Input requires a ready Claude Agent session; steering is unsupported.");
    if (!command.input.trim()) return rejected("invalid_state", "Input must contain text.");
    const id = this.createId();
    let acknowledge!: (accepted: boolean) => void;
    const accepted = new Promise<boolean>((resolve) => { acknowledge = resolve; });
    session.reportedDenials.clear(); session.streamApiMessageIds.clear(); session.completedBlockCounts.clear();
    session.tools.clear(); session.workers.clear();
    session.active = { id, acknowledged: false, idle: false, interruptRequested: false, completed: false, acknowledge, accepted };
    this.state(session, "running", session.confirmed ? "queued" : "queued_awaiting_native_identity", {}, command.correlationId);
    if (session.cleanup || session.active?.id !== id || session.active.interruptRequested) {
      const active = session.active;
      if (active?.id === id && active.interruptRequested) {
        active.completed = true; active.acknowledge(false); session.active = undefined;
        if (!session.cleanup) this.state(session, "ready", "cancelled_before_queue", this.permissionDetails(session));
      }
      return rejected("invalid_state", "The Claude Agent input was cancelled before it could be queued.");
    }
    const message = {
      type: "user", message: { role: "user", content: command.input }, parent_tool_use_id: null,
      uuid: id, session_id: session.proposedNativeId,
    } as ClaudeSdkUserMessage;
    if (!session.queue.push(message)) {
      session.active = undefined;
      return resultError(new ClaudeAdapterError("claude_input_closed", "The Claude Agent input stream is closed."));
    }
    const acknowledged = await bounded(accepted, this.inputAckTimeoutMs, () => false);
    if (!acknowledged) {
      if (session.cleanup || session.failure || activeCompleted(session, id)) {
        return resultError(new ClaudeAdapterError("claude_input_cancelled", "Claude Agent input was cancelled before native acknowledgement."));
      }
      const failure = new ClaudeAdapterError("claude_input_acknowledgement_timeout", "Claude Agent did not acknowledge this input; its delivery outcome is unknown and Ace will not resubmit it.");
      this.fail(session, failure);
      return resultError(failure);
    }
    return { status: "ok", value: { accepted: true } };
  }

  observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener): NativeHarnessCommandResult<NativeHarnessObservation> {
    const valid = this.validate(command.session); if (valid) return valid;
    const session = this.session!;
    session.listeners.add(listener);
    if (session.snapshot) this.deliver(listener, session.snapshot);
    return { status: "ok", value: { dispose: () => { session.listeners.delete(listener); } } };
  }

  async interrupt(command: InterruptSessionCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const valid = this.validate(command.session); if (valid) return valid;
    const session = this.session!;
    const active = session.active;
    if (!active || active.completed || active.interruptRequested) return rejected("invalid_state", "Interrupt requires one active Claude Agent turn.");
    active.interruptRequested = true;
    this.clearApprovals(session, "The turn was interrupted.");
    try {
      const receipt = await session.query.interrupt();
      if (!active.completed && receipt?.still_queued?.includes(active.id)) {
        if (active.acknowledged) this.complete(session, active, "interrupted", undefined, { reason: command.reason, queuedInputCouldNotBeCancelled: true }, command.correlationId);
        else active.acknowledge(false);
        this.publish(session, { type: "session.cancelled", reason: command.reason, nativeState: "queued_input_closed" }, command.correlationId);
        session.state = "terminal";
        await this.cleanup(session);
      }
      return { status: "ok", value: { accepted: true } };
    } catch (error) {
      if (session.active !== active || active.completed) {
        return rejected("invalid_state", "The interrupted Claude Agent turn ended before the interrupt response arrived.");
      }
      this.fail(session, error);
      return resultError(error);
    }
  }

  async respondToApproval(command: RespondToApprovalCommand): Promise<NativeHarnessCommandResult<CommandAccepted>> {
    const valid = this.validate(command.session); if (valid) return valid;
    const session = this.session!;
    const pending = session.approvals.get(command.approvalId);
    if (!pending || pending.resolved) return rejected("stale_approval", "This Claude Agent permission request is no longer pending.");
    if (pending.correlationId !== command.correlationId) return rejected("approval_mismatch", "The response does not match this live permission request.");
    if (!session.active || session.active.id !== pending.turnId || session.active.interruptRequested) return rejected("stale_approval", "This permission request no longer belongs to an active Claude Agent turn.");
    if (command.decision !== "allow_once" && command.decision !== "deny") return rejected("invalid_approval_decision", "Choose allow once or deny.");
    pending.resolved = command.decision;
    session.approvals.delete(pending.id); session.approvalsByKey.delete(pending.key);
    pending.resolve(command.decision === "allow_once"
      ? { behavior: "allow", updatedInput: pending.input, toolUseID: pending.toolUseId }
      : { behavior: "deny", message: "Denied by the user in Ace.", toolUseID: pending.toolUseId });
    this.publish(session, { type: "approval.resolved", approvalId: pending.id, decision: command.decision, nativeApprovalId: pending.toolUseId }, command.correlationId);
    if (session.active && !session.cleanup) this.state(session, "running", "permission_resolved", this.permissionDetails(session));
    return { status: "ok", value: { accepted: true } };
  }

  async deliverExternalOutput(_command: DeliverExternalOutputCommand): Promise<NativeHarnessCommandResult<NativeExternalOutputResult>> {
    return { status: "unsupported", operation: "deliverExternalOutput",
      reason: "Claude external intake requires a separately validated native capability." };
  }

  async dispose(command: DisposeSessionCommand): Promise<NativeHarnessCommandResult<SessionDisposed>> {
    const opening = this.opening;
    if (opening && opening.sessionId === command.session.sessionId && command.session.adapterId === this.adapterId) {
      opening.cancelled = true; opening.controller.abort();
      if (this.session) await this.cleanup(this.session);
      await opening.settled;
      if (this.session) {
        const clean = await this.cleanup(this.session);
        if (!clean) return resultError(new ClaudeAdapterError("claude_cleanup_incomplete", "Claude Agent did not finish closing. Retry closing this session before releasing ownership."));
        this.session.state = "disposed"; this.session.listeners.clear(); this.session = undefined;
      }
      return { status: "ok", value: { disposed: true } };
    }
    const valid = this.validate(command.session, true); if (valid) return valid;
    const session = this.session!;
    const clean = await this.cleanup(session);
    if (!clean) return resultError(new ClaudeAdapterError("claude_cleanup_incomplete", "Claude Agent did not finish closing. Retry closing this session before releasing ownership."));
    session.state = "disposed"; session.listeners.clear();
    if (this.session === session) this.session = undefined;
    return { status: "ok", value: { disposed: true } };
  }

  private async read(session: Session): Promise<void> {
    try {
      for await (const raw of session.query) {
        this.assertOpen(session);
        await this.message(session, raw);
      }
      if (!session.cleanup && session.state !== "disposed" && session.state !== "terminal") {
        this.fail(session, new ClaudeAdapterError("claude_stream_ended", "Claude Agent ended before the session was closed."));
      }
    } catch (error) {
      if (session.state !== "disposed" && !session.cleanup) this.fail(session, error);
    }
  }

  private async message(session: Session, raw: ClaudeSdkMessage): Promise<void> {
    if (!object(raw)) throw new ClaudeAdapterError("incompatible_claude_protocol", "Claude Agent emitted an invalid message.");
    const nativeId = messageSessionId(raw);
    if (nativeId && nativeId !== session.proposedNativeId) throw new ClaudeAdapterError("claude_session_identity_mismatch", "Claude Agent changed the native session identity.");
    if (raw.type === "system" && raw.subtype === "init") { await this.initialize(session, raw); return; }
    if (!session.confirmed) throw new ClaudeAdapterError("claude_identity_unconfirmed", "Claude Agent emitted turn data before confirming its native session identity.");
    const active = session.active;
    const ids = correlations(raw);
    const turnScoped = raw.type === "stream_event" || raw.type === "assistant" || raw.type === "user" ||
      raw.type === "tool_progress" || raw.type === "result" ||
      (raw.type === "system" && ["task_started", "task_progress", "task_updated", "task_notification", "permission_denied"].includes(String(raw.subtype)));
    if (turnScoped && (!active || (ids.length > 0 && !ids.includes(active.id)) || (!active.acknowledged && !ids.includes(active.id)))) return;
    if (active && ids.includes(active.id)) this.acknowledge(session, active, raw);
    if (raw.type === "stream_event") this.streamEvent(session, raw);
    else if (raw.type === "assistant") this.assistant(session, raw);
    else if (raw.type === "user") this.userMessage(session, raw);
    else if (raw.type === "tool_progress") this.toolProgress(session, raw);
    else if (raw.type === "result") this.result(session, raw);
    else if (raw.type === "system") this.system(session, raw);
  }

  private async initialize(session: Session, message: Record<string, unknown>): Promise<void> {
    if (message.session_id !== session.proposedNativeId || message.apiKeySource !== "ANTHROPIC_API_KEY" ||
        message.claude_code_version !== TESTED_CLAUDE_CODE_VERSION || !text(message.cwd)) {
      throw new ClaudeAdapterError("incompatible_claude_runtime", "Claude Agent native identity, API-key route, workspace, or runtime version did not match the tested adapter boundary.");
    }
    const workspace = await captureWorkspaceIdentity(String(message.cwd));
    if (!sameWorkspace(workspace, session.workspace)) throw new ClaudeAdapterError("claude_workspace_mismatch", "Claude Agent opened a different workspace.");
    const mode = text(message.permissionMode);
    if (!supportedPermissionMode(mode)) throw new ClaudeAdapterError("claude_permission_mode_unsupported", "Claude Agent reported an unsupported permission mode.");
    if (!session.confirmed && mode !== session.expectedPermissionMode) {
      throw new ClaudeAdapterError("claude_permission_mode_mismatch", "Claude Agent did not preserve the resolved permission mode.");
    }
    session.permissionMode = mode;
    if (!session.confirmed) {
      try {
        if (!session.resuming) await this.onNativeSessionConfirmed({ ...session.identity, nativeSessionId: session.proposedNativeId });
        this.assertOpen(session);
        session.identity.nativeSessionId = session.proposedNativeId;
        session.confirmed = true;
        session.confirmResolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Native identity confirmation failed.");
        session.confirmReject(failure); throw failure;
      }
    }
    this.state(session, session.active ? (session.approvals.size ? "waiting_for_approval" : "running") : "ready",
      session.active ? "running" : "idle", this.permissionDetails(session));
  }

  private acknowledge(session: Session, turn: TurnState, message: Record<string, unknown>): void {
    if (turn.acknowledged) return;
    turn.acknowledged = true;
    turn.acknowledge(true);
    this.publish(session, { type: "turn.started", turnId: turn.id, nativeDetails: {
      userMessageUuid: message.user_message_uuid, userMessageUuids: message.user_message_uuids,
    } });
  }

  private streamEvent(session: Session, message: Record<string, unknown>): void {
    const frameUuid = text(message.uuid);
    if (frameUuid && session.seenNativeFrameIds.has(frameUuid)) return;
    if (frameUuid) session.seenNativeFrameIds.add(frameUuid);
    const event = object(message.event) ? message.event : undefined;
    if (!event) return;
    const parent = text(message.parent_tool_use_id) ?? "root";
    if (event.type === "message_start") {
      const apiMessageId = object(event.message) ? text(event.message.id) : undefined;
      if (apiMessageId && session.active) session.streamApiMessageIds.set(parent, { id: apiMessageId, turnId: session.active.id });
      return;
    }
    const deltaValue = object(event.delta) ? event.delta : undefined;
    const index = typeof event.index === "number" && Number.isSafeInteger(event.index) && event.index >= 0 ? event.index : undefined;
    const streamed = session.streamApiMessageIds.get(parent);
    if (event.type !== "content_block_delta" || index === undefined || !streamed || streamed.turnId !== session.active?.id ||
        deltaValue?.type !== "text_delta" || typeof deltaValue.text !== "string" || !deltaValue.text) return;
    const nativeMessageId = this.contentBlockId(parent, streamed.id, index);
    this.publish(session, { type: "conversation.delta", role: "assistant", text: deltaValue.text,
      nativeMessageId, nativeDetails: { apiMessageId: streamed.id, contentBlockIndex: index } });
  }

  private assistant(session: Session, frame: Record<string, unknown>): void {
    const frameUuid = text(frame.uuid);
    if (frameUuid && session.seenNativeFrameIds.has(frameUuid)) return;
    if (frameUuid) session.seenNativeFrameIds.add(frameUuid);
    const message = object(frame.message) ? frame.message : undefined;
    if (!message || !Array.isArray(message.content)) return;
    const apiMessageId = text(message.id);
    const parent = text(frame.parent_tool_use_id) ?? "root";
    const countKey = parent + "\0" + (apiMessageId ?? frameUuid ?? "unknown");
    let blockIndex = session.completedBlockCounts.get(countKey) ?? 0;
    for (const block of message.content) {
      if (!object(block)) { blockIndex++; continue; }
      const nativeMessageId = apiMessageId ? this.contentBlockId(parent, apiMessageId, blockIndex) : frameUuid;
      if (block.type === "text" && typeof block.text === "string" && block.text && nativeMessageId) {
        this.publish(session, { type: "conversation.message", role: "assistant", text: block.text,
          nativeMessageId, nativeDetails: { apiMessageId, contentBlockIndex: blockIndex } });
      }
      if (block.type === "tool_use" && text(block.id) && text(block.name) && !session.tools.has(String(block.id))) {
        const tool: ToolState = { id: String(block.id), name: String(block.name), turnId: session.active!.id, completed: false };
        session.tools.set(tool.id, tool);
        const safeInput = safeToolInput(tool.name, block.input);
        this.publish(session, { type: "tool.activity", toolCallId: tool.id, nativeToolCallId: tool.id,
          name: tool.name, state: "started", input: safeInput });
      }
      blockIndex++;
    }
    session.completedBlockCounts.set(countKey, blockIndex);
  }

  private contentBlockId(parent: string, apiMessageId: string, index: number): string {
    return parent + ":" + apiMessageId + ":" + index;
  }

  private userMessage(session: Session, frame: Record<string, unknown>): void {
    const message = object(frame.message) ? frame.message : undefined;
    const blocks = message && Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!object(block) || block.type !== "tool_result" || !text(block.tool_use_id)) continue;
      const tool = session.tools.get(String(block.tool_use_id));
      if (!tool || tool.completed || tool.turnId !== session.active?.id) continue;
      tool.completed = true;
      const failed = block.is_error === true;
      const output = frame.tool_use_result ?? block.content;
      const detail = object(frame.tool_use_result) ? frame.tool_use_result : object(output) ? output : undefined;
      const safeOutput = (tool.name === "Edit" || tool.name === "Write") && detail
        ? { filePath: detail.filePath, structuredPatch: detail.structuredPatch, gitDiff: detail.gitDiff } : output;
      this.publish(session, { type: "tool.activity", toolCallId: tool.id, nativeToolCallId: tool.id, name: tool.name,
        state: failed ? "failed" : "completed", output: safeOutput });
      if (!failed) this.reportChange(session, tool, output, frame.tool_use_result);
    }
  }

  private reportChange(session: Session, tool: ToolState, output: unknown, structured: unknown): void {
    if (tool.name !== "Edit" && tool.name !== "Write") return;
    const details = object(structured) ? structured : object(output) ? output : undefined;
    const filePath = details && text(details.filePath);
    if (!filePath) return;
    const gitDiff = object(details.gitDiff) && typeof details.gitDiff.patch === "string" ? details.gitDiff.patch : undefined;
    const nativeKind = object(details.gitDiff) ? details.gitDiff.status : undefined;
    const kind = nativeKind === "added" || details.type === "create" ? "added" : nativeKind === "modified" || details.type === "update" ? "modified" : "unknown";
    this.publish(session, { type: "change.reported", changeId: tool.id, nativeChangeId: tool.id,
      files: [{ path: filePath, kind }], summary: tool.name + " " + filePath,
      nativeDetails: { ...(gitDiff ? { gitDiff } : {}),
        ...(Array.isArray(details.structuredPatch) ? { structuredPatch: details.structuredPatch } : {}) },
    });
  }

  private toolProgress(session: Session, message: Record<string, unknown>): void {
    const id = text(message.tool_use_id); const name = text(message.tool_name);
    if (!id || !name || session.tools.get(id)?.turnId !== session.active?.id) return;
    this.publish(session, { type: "tool.activity", toolCallId: id, nativeToolCallId: id, name, state: "started",
      nativeState: "running", nativeDetails: { elapsedTimeSeconds: message.elapsed_time_seconds } });
  }

  private system(session: Session, message: Record<string, unknown>): void {
    if (message.subtype === "status" && text(message.permissionMode)) {
      if (!supportedPermissionMode(message.permissionMode)) throw new ClaudeAdapterError("claude_permission_mode_unsupported", "Claude Agent reported an unsupported permission mode.");
      session.permissionMode = message.permissionMode;
      if (session.state !== "terminal" && session.state !== "disposed") {
        this.state(session, session.state, String(message.status ?? "status"), this.permissionDetails(session));
      }
      return;
    }
    if (message.subtype === "session_state_changed") {
      if (message.state === "idle" && session.active?.acknowledged) { session.active.idle = true; this.finishIfReconciled(session); }
      return;
    }
    if (message.subtype === "permission_denied") {
      const id = text(message.tool_use_id); const name = text(message.tool_name);
      if (id && name && !session.reportedDenials.has(id)) {
        session.reportedDenials.add(id);
        this.publish(session, { type: "tool.activity", toolCallId: id, nativeToolCallId: id, name,
          state: "failed", nativeState: "permission_denied", output: text(message.message),
          nativeDetails: { decisionReason: message.decision_reason, decisionReasonType: message.decision_reason_type } });
      }
      return;
    }
    if (["task_started", "task_progress", "task_updated", "task_notification"].includes(String(message.subtype))) this.task(session, message);
  }

  private task(session: Session, message: Record<string, unknown>): void {
    const id = text(message.task_id); if (!id) return;
    const known = session.workers.has(id);
    const local = message.task_type === "local_agent" || typeof message.subagent_type === "string";
    if (message.subtype === "task_started" && local) session.workers.add(id);
    if (!known && !local) return;
    const patch = object(message.patch) ? message.patch : {};
    const native = String(patch.status ?? message.status ?? (message.subtype === "task_started" ? "running" : "running"));
    const state = native === "completed" ? "completed" : native === "failed" || native === "killed" || native === "stopped" ? "failed" : known ? "running" : "started";
    this.publish(session, { type: "worker.status", workerId: id, nativeWorkerId: id, state,
      label: text(message.description) ?? text(message.summary), nativeState: native,
      nativeDetails: { taskType: message.task_type, subagentType: message.subagent_type, outputFile: message.output_file } });
    if (state === "completed" || state === "failed") session.workers.delete(id);
  }

  private result(session: Session, message: Record<string, unknown>): void {
    const active = session.active;
    if (!active || active.completed) return;
    if (!correlations(message).includes(active.id)) {
      this.fail(session, new ClaudeAdapterError("claude_turn_correlation_unknown", "Claude Agent returned a result without the active input identity; Ace will not guess its outcome."));
      return;
    }
    this.acknowledge(session, active, message);
    active.result = message;
    if (Array.isArray(message.permission_denials)) {
      for (const denial of message.permission_denials) {
        if (!object(denial) || !text(denial.tool_use_id) || !text(denial.tool_name) || session.reportedDenials.has(String(denial.tool_use_id))) continue;
        const id = String(denial.tool_use_id); session.reportedDenials.add(id);
        this.publish(session, { type: "tool.activity", toolCallId: id, nativeToolCallId: id, name: String(denial.tool_name),
          state: "failed", nativeState: "permission_denied", input: safeToolInput(String(denial.tool_name), denial.tool_input),
          nativeDetails: { authoritativeResultDenial: true } });
      }
    }
    this.clearApprovals(session, "The Claude Agent turn ended.");
    this.finishIfReconciled(session);
  }

  private finishIfReconciled(session: Session): void {
    const active = session.active; if (!active || active.completed) return;
    if (active.result && active.idle) {
      if (active.reconciliation) clearTimeout(active.reconciliation);
      const outcome = terminalOutcome(active.result);
      const details = safeResult(active.result);
      this.complete(session, active, outcome,
        active.result.subtype === "success" ? active.result.result : undefined, details);
      session.active = undefined;
      if (!session.cleanup) this.state(session, "ready", "idle", this.permissionDetails(session), undefined, active.id);
      return;
    }
    if ((active.result || active.idle) && !active.reconciliation) {
      active.reconciliation = setTimeout(() => {
        if (session.active === active && !active.completed) this.fail(session,
          new ClaudeAdapterError("claude_turn_reconciliation_timeout", "Claude Agent did not provide both a correlated result and authoritative idle state; the turn outcome is uncertain."));
      }, this.reconciliationTimeoutMs);
      active.reconciliation.unref?.();
    }
  }

  private complete(session: Session, turn: TurnState, outcome: NativeHarnessTurnOutcome, result?: unknown,
    nativeDetails?: Record<string, unknown>, correlationId?: string): void {
    if (turn.completed) return; turn.completed = true;
    this.publish(session, { type: "turn.completed", turnId: turn.id, outcome, result,
      ...(outcome === "failed" ? { error: { code: "claude_turn_failed", message: "Claude Agent did not complete the turn successfully.", retryable: true, nativeDetails } } : {}),
      nativeDetails }, correlationId);
  }

  private async permissionCallback(session: Session, toolName: string, input: Record<string, unknown>, details: {
    signal: AbortSignal; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string; title?: string;
    displayName?: string; description?: string; toolUseID: string; agentID?: string; requestId: string;
    matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
  }): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID: string } |
    { behavior: "deny"; message: string; toolUseID: string }> {
    const deny = (message: string) => ({ behavior: "deny" as const, message, toolUseID: details.toolUseID });
    const active = session.active;
    if (!active || active.completed || details.signal.aborted) return deny("The Claude Agent turn is no longer active.");
    if (toolName === "AskUserQuestion") {
      if (session.confirmed) this.publish(session, { type: "tool.activity", toolCallId: details.toolUseID,
        nativeToolCallId: details.toolUseID, name: toolName, state: "failed", nativeState: "unsupported_structured_question" });
      return deny("Ace does not support Claude Agent structured questions in this adapter. Ask the user in ordinary conversation instead.");
    }
    const key = details.requestId + "\0" + details.toolUseID;
    const existing = session.approvalsByKey.get(key);
    if (existing) return existing.promise;
    if (session.seenApprovalKeys.has(key)) return deny("This native permission request is stale.");
    try { await Promise.race([session.confirmation, new Promise<never>((_, reject) => details.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]); }
    catch { return deny("Ace could not confirm the native Claude Agent session."); }
    if (session.active !== active || active.completed || session.cleanup || details.signal.aborted) return deny("The Claude Agent turn is no longer active.");
    const duplicate = session.approvalsByKey.get(key); if (duplicate) return duplicate.promise;
    if (session.seenApprovalKeys.has(key)) return deny("This native permission request is stale.");
    let resolve!: PendingApproval["resolve"];
    const promise = new Promise<Awaited<PendingApproval["promise"]>>((done) => { resolve = done; });
    const id = this.createId(); const correlationId = this.createId();
    const pending: PendingApproval = { id, key, correlationId, turnId: active.id, toolUseId: details.toolUseID, input: structuredClone(input), resolve, promise };
    session.approvals.set(id, pending); session.approvalsByKey.set(key, pending); session.seenApprovalKeys.add(key);
    let published = false;
    const abort = () => {
      if (pending.resolved) return;
      pending.resolved = "cancelled"; session.approvals.delete(id); session.approvalsByKey.delete(key);
      resolve(deny("The permission request was cancelled."));
      if (published) this.publish(session, { type: "approval.resolved", approvalId: id, decision: "cancelled", nativeApprovalId: details.toolUseID }, correlationId);
    };
    details.signal.addEventListener("abort", abort, { once: true });
    if (details.signal.aborted || session.active !== active || active.interruptRequested || session.cleanup) abort();
    if (!pending.resolved) {
      published = true;
      this.publish(session, { type: "approval.requested", approvalId: id, nativeApprovalId: details.toolUseID,
        prompt: details.title ?? details.displayName ?? details.description ?? ("Allow Claude Agent to use " + toolName + "?"),
        choices: ["allow_once", "deny"], nativeDetails: { toolName, input, reason: details.decisionReason ?? details.description,
          scope: details.matchedAskRule, requestId: details.requestId, toolUseId: details.toolUseID } }, correlationId);
    }
    if (!pending.resolved && !session.cleanup && session.active === active && !active.interruptRequested) {
      this.state(session, "waiting_for_approval", "permission_required", this.permissionDetails(session));
    } else if (!pending.resolved) abort();
    return promise.finally(() => details.signal.removeEventListener("abort", abort));
  }

  private clearApprovals(session: Session, message: string): void {
    const pending = [...session.approvals.values()].filter((approval) => !approval.resolved);
    session.approvals.clear();
    for (const approval of pending) {
      approval.resolved = "cancelled";
      session.approvalsByKey.delete(approval.key);
      approval.resolve({ behavior: "deny", message, toolUseID: approval.toolUseId });
    }
    for (const approval of pending) {
      this.publish(session, { type: "approval.resolved", approvalId: approval.id, decision: "cancelled",
        nativeApprovalId: approval.toolUseId }, approval.correlationId, approval.turnId);
    }
  }

  private permissionDetails(session: Session): Record<string, unknown> {
    return { permissionContext: { permissionMode: session.permissionMode ?? "awaiting_native_confirmation", rulesMayResolveBeforeCallback: true } };
  }

  private state(session: Session, state: NativeHarnessSessionState, nativeState: string, nativeDetails: Record<string, unknown>, correlationId?: string, turnIdOverride?: string): void {
    session.state = state;
    const event = this.event(session, { type: "session.state", state, nativeState, nativeDetails }, correlationId, turnIdOverride);
    session.snapshot = event; this.deliverAll(session, event);
  }

  private publish(session: Session, payload: NativeHarnessEventPayload, correlationId?: string, turnIdOverride?: string): void {
    this.deliverAll(session, this.event(session, payload, correlationId, turnIdOverride));
  }

  private event(session: Session, payload: NativeHarnessEventPayload, correlationId?: string, turnIdOverride?: string): NativeHarnessEvent {
    const turnId = turnIdOverride ?? ("turnId" in payload ? payload.turnId : session.active?.id);
    return { ...payload, adapterId: this.adapterId, sessionId: session.identity.sessionId,
      ...(session.confirmed || session.resuming ? { nativeSessionId: session.proposedNativeId } : {}),
      ...(turnId ? { turnId } : {}), ...(correlationId ? { correlationId } : {}),
      sequence: ++session.sequence, timestamp: this.now() };
  }

  private deliverAll(session: Session, event: NativeHarnessEvent): void {
    session.eventQueue.push(event);
    if (session.publishing) return;
    session.publishing = true;
    try {
      while (session.eventQueue.length) {
        const next = session.eventQueue.shift()!;
        for (const listener of [...session.listeners]) this.deliver(listener, next);
      }
    } finally { session.publishing = false; }
  }

  private deliver(listener: NativeHarnessEventListener, event: NativeHarnessEvent): void {
    try { listener(structuredClone(event)); } catch { /* Observers cannot break native lifecycle. */ }
  }

  private validate(identity: NativeHarnessSessionIdentity, allowTerminal = false): NativeHarnessCommandResult<never> | undefined {
    if (identity.adapterId !== this.adapterId) return rejected("adapter_mismatch", "This session belongs to another native adapter.");
    const session = this.session;
    if (!session || session.identity.sessionId !== identity.sessionId) return rejected("invalid_session", "No active Claude Agent session matches this identity.");
    if (identity.nativeSessionId && identity.nativeSessionId !== session.proposedNativeId) return rejected("invalid_session", "The native Claude Agent session identity does not match.");
    if (!allowTerminal && (session.state === "terminal" || session.state === "disposed")) return rejected("invalid_state", "The Claude Agent session has ended.");
  }

  private assertOpen(session: Session): void {
    if (this.session !== session || session.state === "disposed" || session.state === "terminal" || session.failure || session.cleanup) {
      throw session.failure ?? new ClaudeAdapterError("claude_session_closed", "The Claude Agent session has closed.");
    }
  }

  private fail(session: Session, error: unknown): void {
    if (session.failure || session.state === "disposed") return;
    const failure = error instanceof ClaudeAdapterError ? error : new ClaudeAdapterError("claude_adapter_error", error instanceof Error ? error.message : "Claude Agent failed.");
    session.failure = failure; session.state = "terminal";
    if (session.active && !session.active.completed) {
      session.active.acknowledge(false);
      this.complete(session, session.active, "failed", undefined, { code: failure.code });
    }
    this.clearApprovals(session, "The Claude Agent session ended.");
    session.confirmReject(failure);
    this.publish(session, { type: "session.error", error: { code: failure.code, message: failure.message, retryable: true, nativeDetails: failure.details }, nativeState: "error" });
    void this.cleanup(session);
  }

  private cleanup(session: Session): Promise<boolean> {
    if (session.cleanup) return session.cleanup;
    let resolveCleanup!: (clean: boolean) => void;
    const reserved = new Promise<boolean>((resolve) => { resolveCleanup = resolve; });
    session.cleanup = reserved;
    session.active?.acknowledge(false);
    session.confirmReject(new ClaudeAdapterError("claude_session_closed", "The Claude Agent session was closed."));
    this.clearApprovals(session, "The Claude Agent session was closed.");
    if (session.active?.reconciliation) clearTimeout(session.active.reconciliation);
    session.abortController.abort(); session.queue.close();
    let closeOk = true;
    try { session.query.close(); } catch { closeOk = false; }
    const reader = (session.reader ?? Promise.resolve()).then(() => true, () => true);
    const returned = Promise.resolve(session.query.return(undefined)).then(() => true, () => false);
    const completed = Promise.all([reader, returned]).then(([readOk, returnOk]) => closeOk && readOk && returnOk);
    const operation = bounded(completed, this.cleanupTimeoutMs, () => false);
    void operation.then((clean) => {
      resolveCleanup(clean);
      if (!clean && session.cleanup === reserved) session.cleanup = undefined;
    });
    return reserved;
  }
}
