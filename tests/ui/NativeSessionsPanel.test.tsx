import React from "react";
import { render, cleanup } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeSessionsPanel } from "../../src/ui/NativeSessionsPanel.js";
import { NativeSessionService } from "../../src/ui/native-session-service.js";
import { SyntheticNativeAdapter } from "./fixtures/native-ui-scenario.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const services: NativeSessionService[] = [];
async function fixture(start = true) {
  const adapter = new SyntheticNativeAdapter(); const service = new NativeSessionService(adapter); services.push(service);
  const back = vi.fn();
  if (start) await service.start("/synthetic/workspace");
  const view = render(<NativeSessionsPanel service={service} back={back} workspace="/synthetic/workspace" />);
  await tick(); return { adapter, service, view, back };
}
async function key(view: ReturnType<typeof render>, value: string) { view.stdin.write(value); await tick(); }
async function tab(view: ReturnType<typeof render>, count: number) { for (let i = 0; i < count; i++) await key(view, "\u001b[C"); }
afterEach(async () => { cleanup(); await Promise.all(services.splice(0).map((service) => service.dispose())); });

describe("native session panel", () => {
  it("requires harness/workspace selection and treats question marks and quit keys as input text", async () => {
    const { adapter, service, view, back } = await fixture(false);
    const start = vi.spyOn(adapter, "start"); const send = vi.spyOn(adapter, "sendInput");
    expect(view.lastFrame()).toContain("Native coding session");
    expect(start).not.toHaveBeenCalled();
    await key(view, "\r"); expect(view.lastFrame()).toContain("Codex workspace directory");
    expect(start).not.toHaveBeenCalled(); await key(view, "\r");
    expect(start).toHaveBeenCalledOnce(); expect(service.getSnapshot().phase).toBe("ready");
    await key(view, "\r"); await key(view, "why?q");
    expect(view.lastFrame()).toContain("why?q"); expect(view.lastFrame()).not.toContain("Native session keys"); expect(back).not.toHaveBeenCalled();
    await key(view, "\t"); await key(view, "?"); expect(view.lastFrame()).toContain("Native session keys");
    await key(view, "\u001b"); await key(view, "\r"); await key(view, "\r");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ input: "why?q" }));
    expect(service.getSnapshot().phase).toBe("waiting_for_approval");
  });

  it("shows deduplicated output, observed activity and actual diffs without controlling workers", async () => {
    const { service, view } = await fixture(); await service.sendInput("work"); await tick();
    expect(service.getSnapshot().messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(view.lastFrame()).toContain("Reviewing the synthetic example. Turn 1.");
    await tab(view, 1); expect(view.lastFrame()).toContain("Native permissions");
    await key(view, "\u001b[6~");
    expect(view.lastFrame()).toContain("Synthetic observed helper");
    await key(view, "\u001b[6~"); expect(view.lastFrame()).toContain("commandExecution");
    await tab(view, 1); expect(view.lastFrame()).toContain("modified example.ts");
    expect(view.lastFrame()).toContain("+const answer = 2;");
  });

  it("never grants by focus/Enter, explicitly sends one decision, then accepts a new turn", async () => {
    const { adapter, service, view } = await fixture(); await service.sendInput("first"); await tick();
    const respond = vi.spyOn(adapter, "respondToApproval"); await tab(view, 3);
    expect(view.lastFrame()).toContain("Choose with ↑/↓");
    await key(view, "\r"); expect(respond).not.toHaveBeenCalled();
    await key(view, "\u001b[B"); expect(view.lastFrame()).toContain("❯ accept");
    await key(view, "\r"); expect(respond).toHaveBeenCalledOnce();
    expect(service.getSnapshot()).toMatchObject({ phase: "ready", outcome: "completed" });
    await key(view, "\r"); expect(respond).toHaveBeenCalledOnce();
    await key(view, "\t"); await key(view, "second"); await key(view, "\r");
    expect(service.getSnapshot().messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(view.lastFrame()).toContain("1 native"); // One request per turn, old approval is resolved.
  });

  it("never carries a selected decision into a replacement request", async () => {
    const { adapter, service, view } = await fixture(); await service.sendInput("first"); await tick(); await tab(view, 3);
    await key(view, "\u001b[B");
    const respond = vi.spyOn(adapter, "respondToApproval"); const identity = service.getSnapshot().identity!;
    adapter.emit(identity, { type: "approval.resolved", approvalId: "prompt-1", decision: "external" });
    adapter.emit(identity, { type: "approval.requested", approvalId: "replacement", prompt: "Different action", choices: ["accept", "decline"] });
    view.stdin.write("\r"); await tick();
    expect(respond).not.toHaveBeenCalled(); expect(view.lastFrame()).not.toContain("❯ accept");
  });

  it("keeps a running session when navigating away and closes only on explicit action", async () => {
    const { adapter, service, view, back } = await fixture(); await service.sendInput("work"); await tick();
    const dispose = vi.spyOn(adapter, "dispose");
    await key(view, "\u001b"); expect(back).toHaveBeenCalledOnce(); view.unmount();
    expect(dispose).not.toHaveBeenCalled(); expect(service.getSnapshot().approvals).toHaveLength(1);
    const reopened = render(<NativeSessionsPanel service={service} back={back} />); await tick();
    expect(reopened.lastFrame()).toContain("1 native approval");
    await key(reopened, "i"); expect(service.getSnapshot()).toMatchObject({ phase: "ready", outcome: "interrupted" });
    await key(reopened, "x"); expect(dispose).toHaveBeenCalledOnce(); expect(reopened.lastFrame()).toContain("n New session");
  });

  it("handles 48×12 resize safely and disables invisible approval actions", async () => {
    const { adapter, service, view } = await fixture(); await service.sendInput("work"); await tick(); await tab(view, 3);
    await key(view, "\u001b[B"); const respond = vi.spyOn(adapter, "respondToApproval");
    Object.defineProperty(view.stdout, "columns", { value: 48, configurable: true });
    Object.defineProperty(view.stdout, "rows", { value: 12, configurable: true }); view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("Resize to at least 40 columns × 24 rows.");
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(12);
    await key(view, "\r"); await key(view, "i"); await key(view, "x"); expect(respond).not.toHaveBeenCalled(); expect(service.getSnapshot().phase).toBe("waiting_for_approval");
    Object.defineProperty(view.stdout, "rows", { value: 24, configurable: true }); view.stdout.emit("resize"); await tick();
    expect(view.lastFrame()).toContain("4/4 Approvals");
    expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(19); // Shared shell reserves five rows.
    await key(view, "\u001b[6~"); expect(view.lastFrame()).toContain("Lines");
  });
});
