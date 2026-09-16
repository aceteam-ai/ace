export const NATIVE_HARNESS_OPERATIONS = [
  "start",
  "sendInput",
  "deliverExternalOutput",
  "observe",
  "interrupt",
  "respondToApproval",
  "resume",
  "dispose",
] as const;

export type NativeHarnessOperation =
  (typeof NATIVE_HARNESS_OPERATIONS)[number];

export type NativeHarnessCapability =
  | { supported: true }
  | { supported: false; reason: string };

export type NativeHarnessCapabilities = Readonly<
  Record<NativeHarnessOperation, NativeHarnessCapability>
>;

export type NativeDetails = Readonly<Record<string, unknown>>;

export interface NativeHarnessSessionIdentity {
  adapterId: string;
  sessionId: string;
  nativeSessionId?: string;
}

interface CorrelatedCommand {
  correlationId?: string;
}

export interface StartSessionCommand extends CorrelatedCommand {
  type: "session.start";
  sessionId: string;
  workspace: string;
  nativeOptions?: NativeDetails;
}

export interface SendInputCommand extends CorrelatedCommand {
  type: "session.input";
  session: NativeHarnessSessionIdentity;
  input: string;
}

export interface NativeExternalOutputSource {
  /** External collaborators are never represented as the local user. */
  kind: "peer";
  /** Stable, transport-owned peer or subscription identity. */
  id: string;
  /** Optional human-readable peer label; it grants no authority. */
  label?: string;
}

export interface DeliverExternalOutputCommand extends CorrelatedCommand {
  type: "session.external_output";
  session: NativeHarnessSessionIdentity;
  /** Stable journal identity used to reject duplicate native submission. */
  deliveryId: string;
  source: NativeExternalOutputSource;
  content: string;
}

export type NativeExternalOutputStatus =
  | "received"
  | "submitted"
  | "confirmed_accepted"
  | "processed"
  | "unsupported"
  | "unknown";

export type NativeExternalOutputMode = "idle_started" | "busy_queued";

export interface NativeExternalOutputResult {
  deliveryId: string;
  status: NativeExternalOutputStatus;
  mode?: NativeExternalOutputMode;
  nativeTurnId?: string;
  nativeItemId?: string;
  /** True when this call observed a prior receipt instead of writing again. */
  duplicate?: boolean;
  /** Unknown native submission outcomes are never safe for blind replay. */
  retrySafe: boolean;
}

export interface ObserveSessionCommand {
  type: "session.observe";
  session: NativeHarnessSessionIdentity;
}

export interface InterruptSessionCommand extends CorrelatedCommand {
  type: "session.interrupt";
  session: NativeHarnessSessionIdentity;
  reason?: string;
}

export interface RespondToApprovalCommand extends CorrelatedCommand {
  type: "approval.respond";
  session: NativeHarnessSessionIdentity;
  approvalId: string;
  decision: string;
}

export interface ResumeSessionCommand extends CorrelatedCommand {
  type: "session.resume";
  /** Original local registration. Production resume requires this; sessionId is a fresh connection. */
  registeredSessionId?: string;
  sessionId: string;
  nativeSessionId: string;
  workspace: string;
  nativeOptions?: NativeDetails;
}

export interface DisposeSessionCommand {
  type: "session.dispose";
  session: NativeHarnessSessionIdentity;
}

export type NativeHarnessCommand =
  | StartSessionCommand
  | SendInputCommand
  | DeliverExternalOutputCommand
  | ObserveSessionCommand
  | InterruptSessionCommand
  | RespondToApprovalCommand
  | ResumeSessionCommand
  | DisposeSessionCommand;

export interface CommandAccepted {
  accepted: true;
}

export interface SessionDisposed {
  disposed: true;
}

export interface NativeHarnessObservation {
  dispose(): void;
}

export type NativeHarnessRejectionCode =
  | "adapter_mismatch"
  | "duplicate_session"
  | "invalid_session"
  | "invalid_state"
  | "invalid_external_output"
  | "stale_approval"
  | "approval_mismatch"
  | "invalid_approval_decision";

export type NativeHarnessCommandResult<T> =
  | { status: "ok"; value: T }
  | {
      status: "unsupported";
      operation: NativeHarnessOperation;
      reason: string;
    }
  | {
      status: "rejected";
      code: NativeHarnessRejectionCode;
      message: string;
    }
  | {
      status: "error";
      code: string;
      message: string;
      nativeDetails?: NativeDetails;
    };

export type ConversationRole = "user" | "assistant" | "system";

export type NativeHarnessSessionState =
  | "starting"
  | "ready"
  | "running"
  | "waiting_for_approval";

export interface NativeHarnessTurnError {
  code: string;
  message: string;
  retryable: boolean;
  nativeDetails?: NativeDetails;
}

export type NativeHarnessTurnOutcome = "completed" | "interrupted" | "failed";

/** A local correlation ID is distinct from an ID minted by the native harness. */
export type NativeHarnessTurnIdentity =
  | { nativeTurnId: string; turnId?: string }
  | { turnId: string; nativeTurnId?: undefined };

export type NativeHarnessEventPayload =
  | (NativeHarnessTurnIdentity & {
      type: "turn.started";
      nativeDetails?: NativeDetails;
    })
  | (NativeHarnessTurnIdentity & {
      type: "turn.completed";
      outcome: NativeHarnessTurnOutcome;
      result?: unknown;
      error?: NativeHarnessTurnError;
      nativeState?: string;
      nativeDetails?: NativeDetails;
    })
  | {
      type: "session.state";
      state: NativeHarnessSessionState;
      nativeState?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "conversation.delta";
      role: ConversationRole;
      text: string;
      nativeMessageId?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "conversation.message";
      role: ConversationRole;
      text: string;
      nativeMessageId?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "worker.status";
      workerId: string;
      state: "started" | "running" | "completed" | "failed";
      label?: string;
      nativeWorkerId?: string;
      nativeState?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "tool.activity";
      toolCallId: string;
      name: string;
      state: "started" | "completed" | "failed";
      input?: unknown;
      output?: unknown;
      nativeToolCallId?: string;
      nativeState?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "external.output.status";
      deliveryId: string;
      status: NativeExternalOutputStatus;
      source: NativeExternalOutputSource;
      mode?: NativeExternalOutputMode;
      nativeItemId?: string;
      retrySafe: boolean;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "change.reported";
      changeId: string;
      files: ReadonlyArray<{
        path: string;
        kind: "added" | "modified" | "deleted" | "renamed" | "unknown";
      }>;
      summary?: string;
      nativeChangeId?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "approval.requested";
      approvalId: string;
      prompt: string;
      choices: readonly string[];
      nativeApprovalId?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "approval.resolved";
      approvalId: string;
      decision: string;
      nativeApprovalId?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "session.completed";
      result?: unknown;
      nativeState?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "session.cancelled";
      reason?: string;
      nativeState?: string;
      nativeDetails?: NativeDetails;
    }
  | {
      type: "session.error";
      error: {
        code: string;
        message: string;
        retryable: boolean;
        nativeDetails?: NativeDetails;
      };
      nativeState?: string;
    };

export type NativeHarnessEvent = NativeHarnessEventPayload & {
  adapterId: string;
  sessionId: string;
  nativeSessionId?: string;
  /** Present when this event describes a known native turn; approvals keep request correlation. */
  nativeTurnId?: string;
  /** Ace-owned turn identity for harnesses without a native-minted turn ID. */
  turnId?: string;
  correlationId?: string;
  sequence: number;
  timestamp: string;
};

export type NativeHarnessEventListener = (event: NativeHarnessEvent) => void;

export interface NativeHarnessAdapter {
  readonly adapterId: string;
  readonly capabilities: NativeHarnessCapabilities;

  start(
    command: StartSessionCommand
  ): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>>;
  sendInput(
    command: SendInputCommand
  ): Promise<NativeHarnessCommandResult<CommandAccepted>>;
  deliverExternalOutput(
    command: DeliverExternalOutputCommand
  ): Promise<NativeHarnessCommandResult<NativeExternalOutputResult>>;
  observe(
    command: ObserveSessionCommand,
    listener: NativeHarnessEventListener
  ): NativeHarnessCommandResult<NativeHarnessObservation>;
  interrupt(
    command: InterruptSessionCommand
  ): Promise<NativeHarnessCommandResult<CommandAccepted>>;
  respondToApproval(
    command: RespondToApprovalCommand
  ): Promise<NativeHarnessCommandResult<CommandAccepted>>;
  resume(
    command: ResumeSessionCommand
  ): Promise<NativeHarnessCommandResult<NativeHarnessSessionIdentity>>;
  dispose(
    command: DisposeSessionCommand
  ): Promise<NativeHarnessCommandResult<SessionDisposed>>;
}
