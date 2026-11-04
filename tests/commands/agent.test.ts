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

const agentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

it("unwraps only the structured carrier, not receipt metadata", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  fakeClient.callTool.mockResolvedValueOnce({
    content: [
      { type: "text", text: JSON.stringify({ acting_org_id: "org-a", result: "Done" }) },
      { type: "text", text: "_receipt: private metadata" },
    ],
    structuredContent: {
      acting_org_id: "org-a", result: "Done", _receipt: { private: true }, non_home_org: false,
    },
  });
  await agentCommand.parseAsync(["ask", agentId, "Hello", "--json"], { from: "user" });
  expect(output).toHaveBeenCalledWith(JSON.stringify({ agent_id: agentId, response: "Done" }));
  expect(fakeClient.callTool).toHaveBeenCalledTimes(1);
});

it.each(["42", "null", "true", '{"answer":"yes"}'])(
  "keeps answer text %s as a string in JSON output",
  async (answer) => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    fakeClient.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: answer }] });
    await agentCommand.parseAsync(["ask", agentId, "Hello", "--json"], { from: "user" });
    expect(output).toHaveBeenCalledWith(JSON.stringify({ agent_id: agentId, response: answer }));
  },
);

it.each(["blocked", "error", "denied"])("exits 4 for a %s status stub", async (status) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fakeClient.callTool.mockResolvedValueOnce({ structuredContent: { status, _receipt: { private: true } } });
  await agentCommand.parseAsync(["ask", agentId, "Hello", "--json"], { from: "user" });
  expect(process.exitCode).toBe(4);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('"code":4'));
});

it("keeps pending at exit 0 without transport metadata", async () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  fakeClient.callTool.mockResolvedValueOnce({
    structuredContent: { status: "pending", approval_id: "approval-1", _receipt: { private: true }, acting_org_id: "org-a" },
  });
  await agentCommand.parseAsync(["ask", agentId, "Hello", "--json"], { from: "user" });
  expect(process.exitCode || 0).toBe(0);
  expect(output).toHaveBeenCalledWith(JSON.stringify({
    agent_id: agentId, response: { status: "pending", approval_id: "approval-1" },
  }));
});

it.each([
  "You are not a member of that organization, or it does not exist.",
  "This connection has not been granted cross-org access.",
  `Agent not found with ID: ${agentId}`,
  "Insufficient ACET balance to complete this request.",
  "ACET debit denied",
  "Could not verify your organization's ACET balance, so this request was refused.",
  "Error chatting with agent: private exception text",
])("exits 4 for a plain-text refusal", async (message) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fakeClient.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: message }] });
  await agentCommand.parseAsync(["ask", agentId, "Hello", "--json"], { from: "user" });
  expect(process.exitCode).toBe(4);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('"code":4'));
});

it("does not call chat_with_agent when a name is ambiguous", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  fakeClient.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ entries: [
    { id: "agent-1", kind: "agent", name: "Researcher" },
    { id: "agent-2", kind: "agent", name: "Researcher" },
  ] }) }] });
  await agentCommand.parseAsync(["ask", "Researcher", "Hello", "--json"], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(fakeClient.callTool).toHaveBeenCalledTimes(1);
});
