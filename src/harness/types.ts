export const NATIVE_HARNESS_OPERATIONS = [
  "start",
  "sendInput",
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
  | "stale_approval"
  | "approval_mismatch";

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

export type NativeHarnessEventPayload =
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
