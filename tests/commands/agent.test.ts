import { afterEach, expect, it, vi } from "vitest";

const fakeClient = vi.hoisted(() => ({
  ensureSelectedOrg: vi.fn(async () => ({ organization_id: "org-a" })),
  callTool: vi.fn(async (name: string) => name === "agent_peers"
    ? { content: [{ type: "text", text: JSON.stringify({ entries: [
      { id: "agent-1", kind: "agent", name: "Researcher", ref: null },
    ], count: 1 }) }, { type: "text", text: "_receipt: {}" }] }
    : { content: [{ type: "text", text: "Done" }] }),
}));

vi.mock("../../src/utils/control-plane.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/utils/control-plane.js")>();
  return { ...real, configuredClient: () => fakeClient };
});

import { agentCommand, resolveAgent } from "../../src/commands/agent.js";

afterEach(() => {
  fakeClient.callTool.mockClear();
  process.exitCode = 0;
  vi.restoreAllMocks();
});

it("resolves an exact agent name and fences the one-shot turn to the active org", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await agentCommand.parseAsync(["ask", "Researcher", "Summarize this", "--json"], { from: "user" });
  expect(fakeClient.callTool).toHaveBeenNthCalledWith(1, "agent_peers", { kind: "agent" });
  expect(fakeClient.callTool).toHaveBeenNthCalledWith(2, "chat_with_agent", {
    agent_id: "agent-1",
    message: "Summarize this",
    expected_org_id: "org-a",
  });
  expect(output).toHaveBeenCalledWith('{"agent_id":"agent-1","response":"Done"}');
});

it("rejects ambiguous agent names before sending a turn", () => {
  expect(() => resolveAgent([
    { id: "a", kind: "agent", name: "Researcher" },
    { id: "b", kind: "agent", name: "Researcher" },
  ], "Researcher")).toThrow("Agent name is ambiguous");
});

it("reads the agent directory when MCP appends receipt metadata blocks", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await agentCommand.parseAsync(["list", "--json"], { from: "user" });
  expect(output).toHaveBeenCalledWith(expect.stringContaining('"count":1'));
  expect(process.exitCode || 0).toBe(0);
});
