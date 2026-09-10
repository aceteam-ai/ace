import { describe, expect, it, vi } from "vitest";
import { FakeNativeHarnessAdapter } from "../../src/harness/fake.js";
import type { NativeHarnessEventListener, NativeHarnessSessionIdentity, ObserveSessionCommand, StartSessionCommand, SendInputCommand, DisposeSessionCommand, InterruptSessionCommand } from "../../src/harness/types.js";
import { NativeSessionService } from "../../src/ui/native-session-service.js";

class DeferredNative extends FakeNativeHarnessAdapter {
  actual?: NativeHarnessSessionIdentity;
  bound = false;
  listener?: NativeHarnessEventListener;
  constructor() { super({ adapterId: "claude", turnIdentity: "local" }); }
  override async start(command: StartSessionCommand) {
    const result = await super.start(command); if (result.status !== "ok") return result;
    this.actual = result.value;
    return { status: "ok" as const, value: { adapterId: "claude", sessionId: command.sessionId } };
  }
  override observe(command: ObserveSessionCommand, listener: NativeHarnessEventListener) {
    this.listener = listener;
    return super.observe({ ...command, session: this.actual! }, (event) => listener({ ...event, nativeSessionId: this.bound ? event.nativeSessionId : undefined }));
  }
  override sendInput(command: SendInputCommand) { return super.sendInput({ ...command, session: this.actual! }); }
  override interrupt(command: InterruptSessionCommand) { return super.interrupt({ ...command, session: this.actual! }); }
  override dispose(command: DisposeSessionCommand) { return super.dispose({ ...command, session: this.actual! }); }
}

describe("shared deferred native identity", () => {
  it("adopts confirmed identity before a reentrant command and keeps local turn IDs honest", async () => {
    const native = new DeferredNative(); const service = new NativeSessionService(native);
    await service.start("/synthetic"); await service.sendInput("first");
    expect(service.getSnapshot().turnId).toBeDefined(); expect(service.getSnapshot().nativeTurnId).toBeUndefined();
    const interrupt = vi.spyOn(native, "interrupt"); let interrupted: Promise<unknown> | undefined;
    service.subscribe(() => { if (service.getSnapshot().identity?.nativeSessionId && !interrupted && service.getSnapshot().phase === "running" && !service.getSnapshot().interruptPending) interrupted = service.interrupt(); });
    native.bound = true;
    native.emit(native.actual!, { type: "session.state", state: "running" });
    await interrupted;
    expect(interrupt).toHaveBeenCalledOnce();
    expect(interrupt.mock.calls[0][0].session).toEqual(native.actual);
    expect(service.getSnapshot()).toMatchObject({ phase: "ready", outcome: "interrupted" });
    await service.dispose();
  });

  it("clears pending registration on success and retains a failed persistence notice", () => {
    const service = new NativeSessionService(new DeferredNative());
    service.reportRegistrationNotice({ code: "native_identity_pending", message: "Awaiting native confirmation" });
    expect(service.getSnapshot()).toMatchObject({ registrationStatus: "pending" });
    service.reportRegistrationNotice({ code: "native_registration_ready", message: "Ready" });
    expect(service.getSnapshot()).toMatchObject({ registrationStatus: "ready", registrationNotice: undefined });
    service.reportRegistrationNotice({ code: "corrupt_state", message: "Recover local registration" });
    expect(service.getSnapshot()).toMatchObject({ registrationStatus: "unavailable", registrationNotice: "Recover local registration" });
  });

  it("closes a confirmed session on rebinding and disposes its known identity", async () => {
    const native = new DeferredNative(); const service = new NativeSessionService(native);
    await service.start("/synthetic"); native.bound = true; native.emit(native.actual!, { type: "session.state", state: "ready" });
    const dispose = vi.spyOn(native, "dispose");
    native.listener!({ ...native.actual!, nativeSessionId: "foreign", type: "session.state", state: "ready", sequence: 2, timestamp: new Date().toISOString() });
    await vi.waitFor(() => expect(service.getSnapshot().phase).toBe("error"));
    expect(dispose.mock.calls[0][0].session).toEqual(native.actual);
    expect(service.getSnapshot().notice).toContain("changed its confirmed identity");
    await service.dispose();
  });
});
