import { Command } from "commander";
import { CliError, configuredClient, unwrapToolResult, type McpResult } from "../utils/control-plane.js";
import { outputFlags, printValue, runCli } from "../utils/cli-output.js";

interface AgentEntry {
  id: string;
  name: string;
  kind: string;
  ref?: string | null;
}

function primaryToolValue(result: McpResult): unknown {
  if (result.structuredContent !== undefined) return unwrapToolResult(result);
  const first = result.content?.find((block) => block.type === "text");
  return first ? unwrapToolResult({ content: [first] }) : unwrapToolResult(result);
}

function agentEntries(value: unknown): AgentEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Array.isArray((value as { entries?: unknown }).entries)) {
    throw new CliError(4, "The control plane returned an invalid agent directory.");
  }
  const entries = (value as { entries: unknown[] }).entries;
  if (!entries.every((entry) => entry && typeof entry === "object" &&
      typeof (entry as AgentEntry).id === "string" &&
      typeof (entry as AgentEntry).name === "string" &&
      (entry as AgentEntry).kind === "agent")) {
    throw new CliError(4, "The control plane returned an invalid agent directory.");
  }
  return entries as AgentEntry[];
}

export function resolveAgent(entries: AgentEntry[], selector: string): string {
  const exactId = entries.find((entry) => entry.id === selector);
  if (exactId) return exactId.id;
  const matches = entries.filter((entry) =>
    entry.name === selector || (entry.ref && `${entry.name}#${entry.ref}` === selector),
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new CliError(2, "Agent name is ambiguous. Use its ID from ace agent list.");
  throw new CliError(2, "Agent not found. Run ace agent list.");
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const agentCommand = new Command("agent")
  .description("Discover agents and send one-shot control-plane turns");

const listCommand = agentCommand.command("list")
  .description("List addressable agents in the active organization")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

listCommand.action(async () => {
  const flags = outputFlags(listCommand);
  await runCli(async () => {
    const client = configuredClient();
    await client.ensureSelectedOrg();
    const directory = primaryToolValue(await client.callTool("agent_peers", { kind: "agent" }));
    const entries = agentEntries(directory);
    printValue(directory, flags, () =>
      entries.map((entry) => `${entry.name}  ${entry.id}`).join("\n"),
    );
  }, flags);
});

const askCommand = agentCommand.command("ask")
  .description("Send one independent turn to an organization agent")
  .argument("<agent>", "Agent ID or exact name")
  .argument("<message>", "Message to send")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

askCommand.action(async (selector: string, message: string) => {
  const flags = outputFlags(askCommand);
  await runCli(async () => {
    if (!message.trim()) throw new CliError(2, "Message is empty.");
    const client = configuredClient();
    const identity = await client.ensureSelectedOrg();
    const organizationId = identity.organization_id;
    if (typeof organizationId !== "string") {
      throw new CliError(4, "The control plane returned no active organization.");
    }
    const agentId = uuid.test(selector)
      ? selector
      : resolveAgent(
          agentEntries(primaryToolValue(await client.callTool("agent_peers", { kind: "agent" }))),
          selector,
        );
    const response = primaryToolValue(await client.callTool("chat_with_agent", {
      agent_id: agentId,
      message,
      expected_org_id: organizationId,
    }));
    printValue({ agent_id: agentId, response }, flags, () =>
      typeof response === "string" ? response : JSON.stringify(response, null, 2),
    );
  }, flags);
});
