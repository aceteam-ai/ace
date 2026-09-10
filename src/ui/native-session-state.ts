import type { NativeDetails, NativeHarnessEvent, NativeHarnessSessionIdentity, NativeHarnessTurnOutcome } from "../harness/types.js";
import { sanitizeTerminalText } from "./terminal.js";

export type NativeSessionPhase = "idle" | "starting" | "ready" | "running" | "waiting_for_approval" | "closing" | "closed" | "error";
export interface NativeMessage { key: string; role: string; text: string; complete: boolean }
export interface NativeActivity { key: string; id: string; turnId?: string; name: string; state: string; details: string }
export interface NativeChange { key: string; files: string[]; patch?: string }
export interface NativeApproval {
  id: string;
  correlationId?: string;
  nativeApprovalId?: string;
  turnId?: string;
  prompt: string;
  choices: string[];
  details: string;
  status: "waiting" | "submitting" | "submitted";
}
export interface NativeSessionState {
  phase: NativeSessionPhase;
  identity?: NativeHarnessSessionIdentity;
  workspace?: string;
  nativeState?: string;
  permissionContext?: NativeDetails;
  nativeTurnId?: string;
  turnId?: string;
  outcome?: NativeHarnessTurnOutcome;
  messages: NativeMessage[];
  tools: NativeActivity[];
  workers: NativeActivity[];
  changes: NativeChange[];
  approvals: NativeApproval[];
  notice?: string;
  registrationNotice?: string;
  registrationStatus?: "pending" | "ready" | "unavailable";
  connectionKind?: "new" | "resumed";
  interruptPending: boolean;
  lastSequence: number;
}

export function initialNativeSessionState(): NativeSessionState {
  return { phase: "idle", messages: [], tools: [], workers: [], changes: [], approvals: [], interruptPending: false, lastSequence: 0 };
}
const LIMIT = 200;
export function nativeText(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 2) ?? ""; } catch { text = "Details unavailable"; }
  }
  text = sanitizeTerminalText(text);
  return text.length > 40_000 ? `${text.slice(0, 40_000)}\n[Display truncated]` : text;
}
export function nativeInlineText(value: unknown): string { return nativeText(value).replace(/[\n\t]/g, " "); }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function upsert<T extends { key: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((entry) => entry.key === item.key);
  if (index < 0) return [...items, item].slice(-LIMIT);
  return items.map((entry, i) => i === index ? item : entry);
}
function nativeParams(event: NativeHarnessEvent): Record<string, unknown> {
  return record(event.type === "session.error" ? undefined : record(event.nativeDetails).params);
}
function permissionContext(event: NativeHarnessEvent): NativeDetails | undefined {
  if (event.type === "session.error") return undefined;
  const context = record(event.nativeDetails).permissionContext;
  return context && typeof context === "object" && !Array.isArray(context) ? structuredClone(context) as NativeDetails : undefined;
}
export function nativeProviderLabel(adapterId?: string): string {
  return adapterId === "codex" ? "Codex" : adapterId === "claude" ? "Claude Agent" : nativeInlineText(adapterId ?? "Native harness");
}
export const nativeTurnKey = (value: { nativeTurnId?: string; turnId?: string }): string | undefined => value.nativeTurnId ?? value.turnId;
export function nativePermissionSummary(state: NativeSessionState): string {
  const context = state.permissionContext;
  if (!context) return `Permissions: awaiting ${nativeProviderLabel(state.identity?.adapterId)} confirmation`;
  if (state.identity?.adapterId === "claude") return `Claude mode: ${nativeInlineText(context.permissionMode ?? "unknown")} | Native rules may act before an Ace approval prompt`;
  const sandbox = record(context.sandbox);
  return `Approval: ${nativeInlineText(context.approvalPolicy ?? "unknown")} | Reviewer: ${nativeInlineText(context.approvalsReviewer ?? "unknown")} | Sandbox: ${nativeInlineText(sandbox.type ?? "unknown")}`;
}

/** In-memory presentation only. Native adapter retains request authority and complete protocol detail. */
export function reduceNativeEvent(state: NativeSessionState, event: NativeHarnessEvent): NativeSessionState {
  if (!state.identity || event.adapterId !== state.identity.adapterId || event.sessionId !== state.identity.sessionId ||
      (state.identity.nativeSessionId !== undefined && event.nativeSessionId !== state.identity.nativeSessionId) ||
      (event.nativeSessionId !== undefined && !event.nativeSessionId.trim()) || event.sequence <= state.lastSequence ||
      ["closed", "closing", "error"].includes(state.phase)) return state;
  let next: NativeSessionState = { ...state, lastSequence: event.sequence,
    identity: state.identity.nativeSessionId === undefined && event.nativeSessionId !== undefined
      ? { ...state.identity, nativeSessionId: event.nativeSessionId } : state.identity };
  const turn = nativeTurnKey(event);
  const context = permissionContext(event);
  if (context) next.permissionContext = context;
  const key = `${turn ?? "session"}:${"nativeMessageId" in event ? event.nativeMessageId ?? `event-${event.sequence}` : event.sequence}`;
  switch (event.type) {
    case "session.state":
      return { ...next, phase: event.state, nativeState: nativeText(event.nativeState), nativeTurnId: event.nativeTurnId, turnId: event.turnId, interruptPending: event.state === "ready" ? false : next.interruptPending };
    case "turn.started":
      return { ...next, phase: "running", nativeTurnId: event.nativeTurnId, turnId: event.turnId, outcome: undefined, notice: undefined };
    case "turn.completed":
      return { ...next, outcome: event.outcome, approvals: next.approvals.filter((entry) => entry.turnId !== turn), interruptPending: false,
        notice: event.error ? nativeText(event.error.message) : `Turn ${event.outcome}.` };
    case "conversation.delta":
    case "conversation.message": {
      const previous = next.messages.find((item) => item.key === key);
      if (event.type === "conversation.delta" && previous?.complete) return next;
      next.messages = upsert(next.messages, { key, role: event.role, complete: event.type === "conversation.message",
        text: nativeText(event.type === "conversation.delta" ? `${previous?.text ?? ""}${event.text}` : event.text) });
      return next;
    }
    case "tool.activity": {
      const params = nativeParams(event); const item = record(params.item);
      next.tools = upsert(next.tools, { key: `${turn}:${event.toolCallId}`, id: event.toolCallId, turnId: turn,
        name: nativeText(event.name), state: nativeText(event.nativeState ?? event.state),
        details: nativeText({ input: event.input, output: event.output, changes: item.changes, cwd: item.cwd }) });
      return next;
    }
    case "worker.status":
      next.workers = upsert(next.workers, { key: event.workerId, id: event.workerId, name: nativeText(event.label ?? event.workerId), state: nativeText(event.nativeState ?? event.state), details: nativeText(event.nativeDetails) });
      return next;
    case "change.reported": {
      const params = nativeParams(event); const changes = record(params.item).changes;
      const details = record(event.nativeDetails);
      const patch = typeof details.gitDiff === "string" ? details.gitDiff : Array.isArray(details.structuredPatch)
        ? nativeText(details.structuredPatch) : typeof params.diff === "string" ? params.diff : Array.isArray(changes)
          ? changes.map((change) => record(change).diff).filter((diff): diff is string => typeof diff === "string").join("\n") : undefined;
      next.changes = upsert(next.changes, { key: `${turn}:${event.changeId}`, files: event.files.map((file) => `${nativeText(file.kind)} ${nativeText(file.path)}`), patch: patch ? nativeText(patch) : undefined });
      return next;
    }
    case "approval.requested": {
      const params = nativeParams(event);
      const nativeItemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const item = next.tools.find((tool) => tool.id === nativeItemId && tool.turnId === turn);
      const details = nativeText(event.adapterId === "claude" ? event.nativeDetails : { command: params.command,
        cwd: params.cwd, grantRoot: params.grantRoot, network: params.networkApprovalContext,
        requestedPermissions: params.additionalPermissions, nativeAction: item?.details, requestId: event.nativeApprovalId, nativeTurnId: event.nativeTurnId });
      next.approvals = [...next.approvals.filter((entry) => entry.id !== event.approvalId), {
        id: event.approvalId, correlationId: event.correlationId, nativeApprovalId: event.nativeApprovalId, turnId: turn,
        prompt: nativeText(event.prompt), choices: [...event.choices], details, status: "waiting",
      }];
      return { ...next, phase: "waiting_for_approval" };
    }
    case "approval.resolved":
      return { ...next, approvals: next.approvals.filter((entry) => entry.id !== event.approvalId) };
    case "session.completed":
    case "session.cancelled":
      return { ...next, phase: "closed", approvals: [], interruptPending: false, notice: event.type === "session.completed" ? "Session completed." : nativeText(event.reason ?? "Session cancelled.") };
    case "session.error":
      return { ...next, phase: "error", approvals: [], interruptPending: false, notice: nativeText(event.error.message) };
  }
}
