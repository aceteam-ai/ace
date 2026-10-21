import { Command } from "commander";
import {
  CliError,
  configuredClient,
  unwrapToolResult,
  validateToolArgs,
  type McpTool,
} from "../utils/control-plane.js";
import { outputFlags, printValue, runCli } from "../utils/cli-output.js";

export const whoamiCommand = new Command("whoami")
  .description("Show your control-plane identity and active organization")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

whoamiCommand.action(async () => {
  const flags = outputFlags(whoamiCommand);
  await runCli(async () => {
    const identity = await configuredClient().ensureSelectedOrg();
    printValue(identity, flags);
  }, flags);
});

export const orgCommand = new Command("org").description("Manage the active organization");

const orgListCommand = orgCommand
  .command("list")
  .description("List your active organization memberships")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

orgListCommand.action(async () => {
  const flags = outputFlags(orgListCommand);
  await runCli(async () => {
    const client = configuredClient();
    await client.ensureSelectedOrg();
    const memberships = unwrapToolResult(await client.callTool("list_my_orgs"));
    if (!Array.isArray(memberships)) throw new CliError(4, "Invalid organization list.");
    printValue(
      memberships,
      flags,
      (value) =>
        (value as Array<Record<string, unknown>>)
          .map((org) =>
            [
              org.is_active ? "*" : " ",
              String(org.name || org.organization_id),
              "(" + String(org.org_role || "member") + ")",
              String(org.organization_id),
            ].join(" "),
          )
          .join("\n"),
    );
  }, flags);
});

const orgUseCommand = orgCommand
  .command("use")
  .description("Select an organization for subsequent commands")
  .argument("<org>", "Organization ID or exact name")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

orgUseCommand.action(async (org: string) => {
  const flags = outputFlags(orgUseCommand);
  await runCli(async () => {
    const client = configuredClient();
    if (client.authKind !== "oauth") {
      throw new CliError(3, "Org switching requires browser login with multi-org consent.");
    }
    const memberships = unwrapToolResult(await client.callTool("list_my_orgs"));
    if (!Array.isArray(memberships)) throw new CliError(4, "Invalid organization list.");
    const matches = (memberships as Array<Record<string, unknown>>).filter(
      (entry) => entry.organization_id === org || entry.name === org,
    );
    if (matches.length !== 1) {
      throw new CliError(2, matches.length ? "Organization name is ambiguous." : "Organization not found.");
    }
    const selected = matches[0];
    const organizationId = selected.organization_id;
    if (typeof organizationId !== "string") throw new CliError(4, "Invalid organization ID.");
    await client.callTool("switch_active_org", { organization_id: organizationId });
    const identity = await client.identity();
    if (identity.organization_id !== organizationId) {
      throw new CliError(4, "The control plane did not switch organizations.");
    }
    client.selectOrg(organizationId);
    printValue(
      { organization_id: organizationId, name: selected.name, active: true },
      flags,
      () => "Active organization: " + String(selected.name || organizationId),
    );
  }, flags);
});

function parseArgValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function parseToolArgs(jsonOption: string | boolean | undefined, args: string[]): Record<string, unknown> {
  let parsed: Record<string, unknown> = {};
  if (typeof jsonOption === "string") {
    let value: unknown;
    try {
      value = JSON.parse(jsonOption) as unknown;
    } catch {
      throw new CliError(2, "The --json arguments must be valid JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CliError(2, "The --json arguments must be a JSON object.");
    }
    parsed = value as Record<string, unknown>;
  }
  for (const pair of args) {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new CliError(2, "Use --arg key=value.");
    const key = pair.slice(0, separator);
    if (Object.hasOwn(parsed, key)) throw new CliError(2, "Argument " + key + " was supplied twice.");
    parsed[key] = parseArgValue(pair.slice(separator + 1));
  }
  return parsed;
}

function toolListText(tools: Array<Pick<McpTool, "name" | "description">>): string {
  return tools.map((tool) => tool.name + (tool.description ? "  " + tool.description.split("\n")[0] : "")).join("\n");
}

export const mcpCommand = new Command("mcp")
  .description("Discover and call live AceTeam MCP tools")
  .argument("[tool]", "Tool name")
  .option("--list [query]", "List tools, optionally by search query")
  .option("--schema <tool>", "Show a tool's live input schema")
  .option("--json [args]", "Output JSON, optionally supplying a JSON argument object")
  .option("--arg <key=value>", "Set one tool argument", (value, previous: string[]) => [...previous, value], [])
  .option("--quiet", "Suppress successful output");

mcpCommand.action(async (name: string | undefined) => {
  const options = mcpCommand.opts() as {
    list?: string | boolean;
    schema?: string;
    json?: string | boolean;
    arg: string[];
  };
  const flags = outputFlags(mcpCommand, options.json !== undefined);
  await runCli(async () => {
    const client = configuredClient();
    await client.ensureSelectedOrg();
    if (options.list !== undefined) {
      const query = typeof options.list === "string" ? options.list.trim() : "";
      const tools = query
        ? unwrapToolResult(await client.callTool("find_tools", { query }))
        : await client.listTools();
      const list =
        Array.isArray(tools) ? tools : (tools as { tools?: unknown }).tools;
      if (!Array.isArray(list)) throw new CliError(4, "Invalid tool search result.");
      printValue(list, flags, () => toolListText(list as McpTool[]));
      return;
    }
    if (options.schema) {
      const tool = await client.getTool(options.schema);
      printValue(tool, flags);
      return;
    }
    if (!name) throw new CliError(2, "Supply a tool name, --list, or --schema.");
    const tool = await client.getTool(name);
    const args = parseToolArgs(options.json, options.arg);
    validateToolArgs(tool, args);
    const result = unwrapToolResult(await client.callTool(name, args));
    printValue(result, flags);
  }, flags);
});
