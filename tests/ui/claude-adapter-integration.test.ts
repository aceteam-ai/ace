import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeNativeHarnessAdapter } from "../../src/harness/claude.js";
import { TESTED_CLAUDE_CODE_VERSION, type ClaudeSdkUserMessage } from "../../src/harness/claude-sdk.js";
import { NativeSessionManager } from "../../src/harness/session-manager.js";
import { NativeSessionStore } from "../../src/harness/session-store.js";
import { NativeSessionService } from "../../src/ui/native-session-service.js";
import { nativePermissionSummary } from "../../src/ui/native-session-state.js";
import { SyntheticClaudeSdk, type SyntheticClaudeQuery } from "../harness/fixtures/claude-sdk.js";

let root: string; let workspace: string; let sdk: SyntheticClaudeSdk; let store: NativeSessionStore;
let manager: NativeSessionManager; let actual: ClaudeNativeHarnessAdapter;
const services: NativeSessionService[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ace-claude-shared-")); workspace = join(root, "workspace"); await mkdir(workspace);
  sdk = new SyntheticClaudeSdk(); store = new NativeSessionStore({ directory: join(root, "registrations") });
  let id = 0;
  manager = new NativeSessionManager({ store, adapters: { claude: (sessionStore, hooks) => {
    actual = new ClaudeNativeHarnessAdapter({ sessionStore, onNativeSessionConfirmed: hooks.onNativeSessionConfirmed,
      sdkFactory: async () => sdk, environment: { ANTHROPIC_API_KEY: "synthetic-integration-key" },
      createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      cleanupTimeoutMs: 1000, initializationTimeoutMs: 1000, inputAckTimeoutMs: 2000, reconciliationTimeoutMs: 2000 });
    return actual;
  } } });
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
});
function service() {
  let result: NativeSessionService;
  const adapter = manager.createAdapter("claude", { onNotice: (notice) => result.reportRegistrationNotice(notice) });
  result = new NativeSessionService(adapter); services.push(result); return result;
}
function emit(query: SyntheticClaudeQuery, message: Parameters<SyntheticClaudeQuery["emit"]>[0]) {
  // Each SDK wrapper has its own UUID. Accumulation follows the API message and content block.
  query.emit({ uuid: randomUUID(), ...message });
}
function init(query: SyntheticClaudeQuery, input: ClaudeSdkUserMessage) {
  emit(query, { type: "system", subtype: "init", session_id: input.session_id,
    cwd: workspace, claude_code_version: TESTED_CLAUDE_CODE_VERSION, apiKeySource: "ANTHROPIC_API_KEY", permissionMode: "default" });
}
function result(query: SyntheticClaudeQuery, input: ClaudeSdkUserMessage) {
  emit(query, { type: "result", subtype: "success", is_error: false,
    session_id: input.session_id, user_message_uuid: input.uuid, user_message_uuids: [input.uuid],
    stop_reason: "end_turn", result: "Synthetic completed turn", permission_denials: [] });
}
function idle(query: SyntheticClaudeQuery, input: ClaudeSdkUserMessage) {
  emit(query, { type: "system", subtype: "session_state_changed", state: "idle", session_id: input.session_id });
}
async function begin(view: NativeSessionService, query: SyntheticClaudeQuery, text: string, frame: string) {
  const sending = view.sendInput(text); const input = await query.takeInput(); init(query, input);
  await vi.waitFor(() => expect(view.getSnapshot().identity?.nativeSessionId).toBe(input.session_id));
  emit(query, { type: "stream_event", session_id: input.session_id, parent_tool_use_id: null,
    user_message_uuid: input.uuid, event: { type: "message_start", message: { id: `api-${frame}` } } });
  expect(await sending).toMatchObject({ status: "ok" });
  await vi.waitFor(() => expect(view.getSnapshot().turnId).toBe(input.uuid));
  return input;
}

// Exercises the real adapter/manager/service boundary. SDK, messages, keys and permissions are synthetic.
describe("Claude adapter in the shared managed UI service", () => {
  it("adopts identity, preserves local turn associations, settles text and expires approvals across two explicit turns", async () => {
    const view = service(); expect(sdk.queryCalls).toEqual([]);
    expect(await view.start(workspace)).toMatchObject({ status: "ok" });
    expect(view.getSnapshot()).toMatchObject({ phase: "ready", registrationStatus: "pending" });
    expect(view.getSnapshot().identity?.nativeSessionId).toBeUndefined(); expect(await store.list()).toEqual([]);
    const query = sdk.queries[0]; expect(query.inputs).toEqual([]);
    const first = await begin(view, query, "First synthetic user request", "frame-one");
    expect(view.getSnapshot()).toMatchObject({ registrationStatus: "ready", registrationNotice: undefined, nativeTurnId: undefined });
    expect(nativePermissionSummary(view.getSnapshot())).toContain("Claude mode: default");
    expect(nativePermissionSummary(view.getSnapshot())).not.toContain("Sandbox:");
    expect(view.getSnapshot().permissionContext).toMatchObject({ rulesMayResolveBeforeCallback: true });

    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    for (const text of ["Complete ", "answer."]) emit(query, {
      type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    });
    await vi.waitFor(() => expect(view.getSnapshot().messages).toEqual([
      expect.objectContaining({ key: `${first.uuid}:root:api-frame-one:0`, text: "Complete answer.", complete: false }),
    ]));
    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_stop", index: 0 } });
    emit(query, { type: "assistant", session_id: first.session_id, parent_tool_use_id: null,
      message: { id: "api-frame-one", content: [{ type: "text", text: "Complete answer." }] } });
    // Streamed completions are one block each and may share the API message ID.
    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Second block." } } });
    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_stop", index: 1 } });
    emit(query, { type: "assistant", session_id: first.session_id, parent_tool_use_id: null,
      message: { id: "api-frame-one", content: [{ type: "text", text: "Second block." }] } });
    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_start", index: 2,
        content_block: { type: "tool_use", id: "edit-one", name: "Edit", input: {} } } });
    emit(query, { type: "stream_event", session_id: first.session_id, parent_tool_use_id: null,
      event: { type: "content_block_stop", index: 2 } });
    emit(query, { type: "assistant", session_id: first.session_id, parent_tool_use_id: null,
      message: { id: "api-frame-one", content: [{ type: "tool_use", id: "edit-one", name: "Edit", input: { file_path: "example.ts" } }] } });
    await vi.waitFor(() => expect(view.getSnapshot().messages).toEqual([
      expect.objectContaining({ key: `${first.uuid}:root:api-frame-one:0`, text: "Complete answer.", complete: true }),
      expect.objectContaining({ key: `${first.uuid}:root:api-frame-one:1`, text: "Second block.", complete: true }),
    ]));
    await vi.waitFor(() => expect(view.getSnapshot().tools[0]).toMatchObject({ id: "edit-one", turnId: first.uuid }));

    const canUseTool = sdk.queryCalls[0].options.canUseTool;
    const nativeApproval = canUseTool("Edit", { file_path: "example.ts" }, { signal: new AbortController().signal,
      requestId: "request-one", toolUseID: "edit-one", decisionReason: "Synthetic native ask" });
    await vi.waitFor(() => expect(view.getSnapshot().approvals).toHaveLength(1));
    const approval = view.getSnapshot().approvals[0];
    expect(approval).toMatchObject({ turnId: first.uuid, choices: ["allow_once", "deny"], status: "waiting" });
    expect(approval.details).toContain("file_path"); expect(view.getSnapshot().phase).toBe("waiting_for_approval");
    const respond = vi.spyOn(actual, "respondToApproval");
    expect(await view.respond(approval.id, "allow_once")).toMatchObject({ status: "ok" });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ session: view.getSnapshot().identity,
      approvalId: approval.id, correlationId: approval.correlationId, decision: "allow_once" }));
    expect(await nativeApproval).toMatchObject({ behavior: "allow", toolUseID: "edit-one" });
    expect(await view.respond(approval.id, "allow_once")).toMatchObject({ status: "rejected" }); expect(respond).toHaveBeenCalledOnce();

    const expiring = canUseTool("Read", { file_path: "later.ts" }, { signal: new AbortController().signal, requestId: "request-two", toolUseID: "read-two" });
    await vi.waitFor(() => expect(view.getSnapshot().approvals).toHaveLength(1));
    const staleId = view.getSnapshot().approvals[0].id;
    result(query, first); expect(await expiring).toMatchObject({ behavior: "deny" });
    await vi.waitFor(() => expect(view.getSnapshot().approvals).toEqual([]));
    expect(view.getSnapshot().phase).not.toBe("ready");
    idle(query, first); await vi.waitFor(() => expect(view.getSnapshot()).toMatchObject({ phase: "ready", outcome: "completed" }));
    expect(await view.respond(staleId, "allow_once")).toMatchObject({ status: "rejected" });

    const second = await begin(view, query, "Second explicit user request", "frame-two");
    expect(second.uuid).not.toBe(first.uuid); expect(second.session_id).toBe(first.session_id);
    expect(sdk.queryCalls).toHaveLength(1); expect(view.getSnapshot().nativeTurnId).toBeUndefined();
    result(query, second); idle(query, second);
    await vi.waitFor(() => expect(view.getSnapshot().phase).toBe("ready"));
    expect(query.inputs.map((input) => input.message.content)).toEqual(["First synthetic user request", "Second explicit user request"]);
    const saved = await store.list(); expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ adapterId: "claude", nativeSessionId: first.session_id });
    expect(JSON.stringify(saved)).not.toContain("synthetic user request");
    await view.dispose(); expect(query.closed && query.returned).toBe(true);
    expect(await store.inspectOwnership(saved[0])).toBe("available"); expect(query.inputs).toHaveLength(2);
  });

  it("resumes the registered native session with a fresh local identity and no prompt or approval replay", async () => {
    const firstView = service(); await firstView.start(workspace); const firstQuery = sdk.queries[0];
    const input = await begin(firstView, firstQuery, "One explicit request before restart", "restart-frame");
    const oldIdentity = firstView.getSnapshot().identity;
    const pending = sdk.queryCalls[0].options.canUseTool("Read", { file_path: "example.ts" }, {
      signal: new AbortController().signal, requestId: "restart-request", toolUseID: "restart-tool" });
    await vi.waitFor(() => expect(firstView.getSnapshot().approvals).toHaveLength(1));
    const saved = (await store.list())[0]; await firstView.dispose();
    expect(await pending).toMatchObject({ behavior: "deny" }); expect(firstQuery.closed && firstQuery.returned).toBe(true);
    sdk.sessionInfo = { sessionId: saved.nativeSessionId, cwd: workspace };
    const resumed = service(); expect(await resumed.resume(saved, workspace)).toMatchObject({ status: "ok" });
    expect(resumed.getSnapshot()).toMatchObject({ phase: "ready", connectionKind: "resumed", approvals: [], messages: [] });
    expect(resumed.getSnapshot().identity?.sessionId).not.toBe(oldIdentity?.sessionId);
    expect(resumed.getSnapshot().identity?.nativeSessionId).toBe(input.session_id);
    expect(sdk.getSessionInfoCalls).toEqual([{ sessionId: saved.nativeSessionId, options: { dir: workspace } }]);
    expect(sdk.queryCalls[1].options).toMatchObject({ resume: saved.nativeSessionId });
    expect(sdk.queryCalls[1].options).not.toHaveProperty("sessionId");
    expect(sdk.queries[1].inputs).toEqual([]); expect(firstQuery.inputs).toHaveLength(1);
    await resumed.dispose(); expect(sdk.queries[1].closed && sdk.queries[1].returned).toBe(true);
    expect(await store.inspectOwnership(saved)).toBe("available"); expect(await store.list()).toHaveLength(1);
  });
});
