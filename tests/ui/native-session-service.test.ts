import { describe, expect, it, vi } from "vitest";
import { FakeNativeHarnessAdapter } from "../../src/harness/fake.js";
import type { NativeHarnessCommandResult, NativeHarnessSessionIdentity } from "../../src/harness/types.js";
import { NativeSessionService } from "../../src/ui/native-session-service.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
async function started() {
  const adapter = new FakeNativeHarnessAdapter(); const service = new NativeSessionService(adapter);
  const result = await service.start("/synthetic/workspace");
  if (result.status !== "ok") throw new Error("Synthetic start failed");
  return { adapter, service, identity: result.value };
}

describe("native session service", () => {
  it("does no native work before explicit start, observes after start, and supports follow-up turns", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const start = vi.spyOn(adapter, "start"); const observe = vi.spyOn(adapter, "observe");
    const service = new NativeSessionService(adapter);
    expect(start).not.toHaveBeenCalled();
    expect(await service.sendInput("early")).toMatchObject({ status: "rejected" });
    const result = await service.start("/synthetic/workspace"); if (result.status !== "ok") throw new Error("start");
    expect(observe).toHaveBeenCalledOnce();
    expect(await service.sendInput("first")).toMatchObject({ status: "ok" });
    expect(service.getSnapshot().phase).toBe("running");
    adapter.emit(result.value, { type: "turn.completed", nativeTurnId: service.getSnapshot().nativeTurnId!, outcome: "completed" });
    expect(service.getSnapshot().phase).toBe("ready");
    await service.sendInput("second");
    expect(start).toHaveBeenCalledOnce();
    expect(service.getSnapshot().messages.map((item) => item.text)).toEqual(["first", "second"]);
    await service.interrupt();
    expect(service.getSnapshot()).toMatchObject({ phase: "ready", outcome: "interrupted" });
    await service.dispose();
  });

  it("requires explicit exact approval, blocks duplicate submission, and never revives a resolved request", async () => {
    const { adapter, service, identity } = await started(); await service.sendInput("work");
    adapter.emit(identity, { type: "approval.requested", approvalId: "prompt", prompt: "Run?", choices: ["accept", "decline"] }, "correlation");
    const pending = deferred<NativeHarnessCommandResult<{ accepted: true }>>();
    const respond = vi.spyOn(adapter, "respondToApproval").mockReturnValue(pending.promise);
    expect(await service.respond("prompt", "acceptForSession")).toMatchObject({ status: "rejected" });
    expect(respond).not.toHaveBeenCalled();
    const replying = service.respond("prompt", "decline");
    expect(respond).toHaveBeenCalledWith({ type: "approval.respond", session: identity, approvalId: "prompt", correlationId: "correlation", decision: "decline" });
    expect(await service.respond("prompt", "accept")).toMatchObject({ status: "rejected" });
    adapter.emit(identity, { type: "approval.resolved", approvalId: "prompt", decision: "resolved_externally" });
    pending.resolve({ status: "ok", value: { accepted: true } }); await replying;
    expect(service.getSnapshot().approvals).toEqual([]);
    expect(respond).toHaveBeenCalledOnce(); await service.dispose();
  });

  it("awaits eventual startup cleanup even if provisional disposal throws", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const nativeStart = adapter.start.bind(adapter);
    const opening = deferred<NativeHarnessCommandResult<NativeHarnessSessionIdentity>>();
    vi.spyOn(adapter, "start").mockReturnValue(opening.promise);
    const nativeDispose = adapter.dispose.bind(adapter);
    const dispose = vi.spyOn(adapter, "dispose").mockRejectedValueOnce(new Error("provisional cleanup failed")).mockImplementation(nativeDispose);
    const service = new NativeSessionService(adapter);
    const start = service.start("/synthetic/workspace"); await Promise.resolve();
    const identity = service.getSnapshot().identity!;
    let closed = false; const close = service.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    const actual = await nativeStart({ type: "session.start", sessionId: identity.sessionId, workspace: "/synthetic/workspace" });
    opening.resolve(actual); await start; await close;
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot().phase).toBe("error");
    expect(service.getSnapshot().notice).toContain("provisional cleanup failed");
    await service.dispose();
  });

  it.each(["starting", "ready"] as const)("honors reentrant close during %s publication without submitting subsequent work", async (phase) => {
    const adapter = new FakeNativeHarnessAdapter(); const start = vi.spyOn(adapter, "start"); const observe = vi.spyOn(adapter, "observe");
    const service = new NativeSessionService(adapter);
    let closing: Promise<void> | undefined;
    service.subscribe(() => { if (service.getSnapshot().phase === phase) closing = service.close(); });
    expect(await service.start("/synthetic/workspace")).toMatchObject({ status: "rejected" });
    await closing;
    expect(start).toHaveBeenCalledTimes(phase === "starting" ? 0 : 1);
    expect(observe).toHaveBeenCalledTimes(phase === "starting" ? 0 : 1);
    expect(service.getSnapshot().phase).toBe("closed");
  });

  it.each(["sendInput", "interrupt", "respond"] as const)("does not submit %s if a view listener closes during optimistic update", async (command) => {
    const { adapter, service, identity } = await started();
    if (command !== "sendInput") await service.sendInput("work");
    if (command === "respond") adapter.emit(identity, { type: "approval.requested", approvalId: "prompt", prompt: "Run?", choices: ["accept", "decline"] });
    const submit = vi.spyOn(adapter, command === "respond" ? "respondToApproval" : command);
    let closing: Promise<void> | undefined;
    service.subscribe(() => {
      const state = service.getSnapshot();
      if (state.phase !== "closing" && (command === "sendInput" ? state.phase === "running" : command === "interrupt" ? state.interruptPending : state.approvals[0]?.status === "submitting")) closing = service.close();
    });
    const result = await (command === "respond" ? service.respond("prompt", "accept") : command === "interrupt" ? service.interrupt() : service.sendInput("work"));
    expect(result).toMatchObject({ status: "rejected" });
    expect(submit).not.toHaveBeenCalled(); await closing;
  });


  it("observes output from a reentrant input submitted on the first ready notification", async () => {
    const adapter = new FakeNativeHarnessAdapter(); const service = new NativeSessionService(adapter);
    let submitted: Promise<unknown> | undefined;
    service.subscribe(() => { if (service.getSnapshot().phase === "ready" && !submitted) submitted = service.sendInput("immediate"); });
    await service.start("/synthetic/workspace"); await submitted;
    expect(service.getSnapshot().messages.map((item) => item.text)).toEqual(["immediate"]);
    await service.dispose();
  });

  it("contains thrown command errors and closes unknown outcomes before allowing new sessions", async () => {
    const { adapter, service } = await started();
    vi.spyOn(adapter, "sendInput").mockRejectedValueOnce(new Error("synthetic transport failed"));
    expect(await service.sendInput("work")).toMatchObject({ status: "error" });
    expect(service.getSnapshot()).toMatchObject({ phase: "error", notice: "synthetic transport failed" });
    expect(await service.start("/synthetic/workspace")).toMatchObject({ status: "ok" });
    await service.dispose();
  });

  it("does not let an old input rejection reset a newer active turn", async () => {
    const { adapter, service, identity } = await started();
    const nativeInput = adapter.sendInput.bind(adapter); const delayed = deferred<NativeHarnessCommandResult<{ accepted: true }>>();
    vi.spyOn(adapter, "sendInput").mockImplementationOnce(async (command) => { await nativeInput(command); return delayed.promise; });
    const first = service.sendInput("first"); await Promise.resolve();
    adapter.emit(identity, { type: "turn.completed", nativeTurnId: service.getSnapshot().nativeTurnId!, outcome: "completed" });
    await service.sendInput("second");
    delayed.resolve({ status: "rejected", code: "invalid_state", message: "Old rejection" }); await first;
    expect(service.getSnapshot().phase).toBe("running");
    expect(service.getSnapshot().notice).not.toBe("Old rejection"); await service.dispose();
  });

  it("reports unsupported/authentication startup failures without accepting text", async () => {
    const adapter = new FakeNativeHarnessAdapter();
    vi.spyOn(adapter, "start").mockResolvedValueOnce({ status: "unsupported", operation: "start", reason: "Unsupported installed CLI version" })
      .mockResolvedValueOnce({ status: "error", code: "authentication_required", message: "Sign in with Codex first" });
    const service = new NativeSessionService(adapter);
    expect(await service.start("/synthetic/workspace")).toMatchObject({ status: "unsupported" });
    expect(service.getSnapshot().notice).toContain("Unsupported installed CLI");
    expect(await service.sendInput("work")).toMatchObject({ status: "rejected" });
    expect(await service.start("/synthetic/workspace")).toMatchObject({ status: "error" });
    expect(service.getSnapshot().notice).toBe("Sign in with Codex first"); await service.dispose();
  });
});
