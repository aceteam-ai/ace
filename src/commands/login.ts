import { Command } from "commander";
import { select, password } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, saveConfig, type ControlPlaneSession } from "../utils/config.js";
import { detectOllama } from "../utils/provider-detect.js";
import * as output from "../utils/output.js";
import { CliError, ControlPlaneClient, DEFAULT_MCP_URL, validateMcpUrl } from "../utils/control-plane.js";
import { browserLogin } from "../utils/oauth.js";
import { outputFlags, printValue, runCli, type OutputFlags } from "../utils/cli-output.js";

/**
 * Interactive login/provider configuration flow.
 * Reusable from both `ace login` and the interactive TUI.
 */
export async function runLoginFlow(): Promise<void> {
  const choice = await select({
    message: "How would you like to use Ace?",
    choices: [
      {
        name: "AceTeam Fabric",
        value: "fabric",
        description: "Use an AceTeam API key for local workflows",
      },
      {
        name: "AceTeam control plane",
        value: "control-plane",
        description: "Connect through your browser for org and MCP commands",
      },
      {
        name: "Own API key",
        value: "own-key",
        description: "Use your OpenAI or Anthropic key",
      },
      {
        name: "Ollama (local)",
        value: "ollama",
        description: "Run models locally with Ollama",
      },
      { name: "Skip for now", value: "skip" },
    ],
  });

  switch (choice) {
    case "fabric":
      await loginFabric();
      break;
    case "control-plane":
      await loginAceTeam({ json: false, quiet: false });
      break;
    case "own-key":
      await loginOwnKey();
      break;
    case "ollama":
      await loginOllama();
      break;
    case "skip":
      output.info("Skipped. You can run `ace login` anytime.");
      break;
  }
}

async function loginFabric(): Promise<void> {
  console.log(chalk.dim("\n  Get your API key from https://app.aceteam.ai\n"));
  const apiKey = await password({
    message: "AceTeam API key:",
    validate: (value) => (value.trim() ? true : "API key is required"),
  });
  const config = loadConfig();
  const url = config.fabric_url || "https://app.aceteam.ai";
  const spinner = ora("Verifying connection...").start();
  try {
    const { FabricClient } = await import("../utils/fabric.js");
    await new FabricClient(url, apiKey.trim()).status();
    spinner.succeed("Connected to AceTeam Fabric");
  } catch {
    spinner.fail("Connection failed");
    output.warn("Could not verify the key. Saving it so you can retry with ace fabric login.");
  }
  config.fabric_url = url;
  config.fabric_api_key = apiKey.trim();
  saveConfig(config);
  output.success("Fabric credentials saved");
}

async function loginAceTeam(flags: OutputFlags, mcpUrl?: string): Promise<void> {
  const config = loadConfig();
  const session = await browserLogin(
    mcpUrl || config.control_plane?.mcp_url || DEFAULT_MCP_URL,
    (url) => console.error("Open this URL to authorize Ace: " + url),
  );
  const identity = await new ControlPlaneClient(session).identity();
  if (typeof identity.organization_id !== "string") {
    throw new CliError(4, "The control plane returned no active organization.");
  }
  if (config.control_plane?.kind === "api_key" &&
      config.fabric_api_key === config.control_plane.access_token) {
    delete config.fabric_api_key;
  }
  session.active_org_id = identity.organization_id;
  config.control_plane = session;
  saveConfig(config);
  printValue(
    { authenticated: true, organization_id: identity.organization_id, user_id: identity.user_id },
    flags,
    () => "Connected to AceTeam. Active organization: " + String(identity.organization_id),
  );
}

async function loginOwnKey(): Promise<void> {
  const provider = await select({
    message: "Which provider?",
    choices: [
      { name: "OpenAI", value: "openai" },
      { name: "Anthropic", value: "anthropic" },
    ],
  });

  const key = await password({
    message: `${provider === "openai" ? "OpenAI" : "Anthropic"} API key:`,
    validate: (v) => (v.trim() ? true : "API key is required"),
  });

  const config = loadConfig();
  if (!config.api_keys) {
    config.api_keys = {};
  }

  if (provider === "openai") {
    config.api_keys.openai = key.trim();
    if (!config.default_model) {
      config.default_model = "gpt-4o-mini";
    }
  } else {
    config.api_keys.anthropic = key.trim();
    if (!config.default_model) {
      config.default_model = "claude-sonnet-4-6";
    }
  }

  saveConfig(config);
  output.success(
    `${provider === "openai" ? "OpenAI" : "Anthropic"} API key saved`
  );
}

async function loginOllama(): Promise<void> {
  const spinner = ora("Checking for Ollama...").start();
  const model = await detectOllama();

  if (model) {
    spinner.succeed(`Ollama is running — found model: ${model}`);

    const config = loadConfig();
    config.default_model = `ollama/${model}`;
    saveConfig(config);
    output.success(`Default model set to ollama/${model}`);
  } else {
    spinner.fail("Ollama is not running");
    console.log(
      "\n" +
        chalk.bold("  To use Ollama:") +
        "\n" +
        chalk.dim("  1. Install: https://ollama.ai") +
        "\n" +
        chalk.dim("  2. Start:  ollama serve") +
        "\n" +
        chalk.dim("  3. Pull:   ollama pull llama3") +
        "\n" +
        chalk.dim("  4. Retry:  ace login")
    );
  }
}

export const loginCommand = new Command("login")
  .description("Connect to the control plane or configure a local provider")
  .option("--api-key <key>", "Use an API key for one organization")
  .option("--api-key-env <name>", "Read a single-org API key from an environment variable")
  .option("--browser", "Authorize the control plane in a browser")
  .option("--mcp-url <url>", "Control-plane MCP URL")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

loginCommand.action(async (options: { apiKey?: string; apiKeyEnv?: string; browser?: boolean; mcpUrl?: string }) => {
  const flags = outputFlags(loginCommand);
  await runCli(async () => {
    if (options.apiKey !== undefined && options.apiKeyEnv !== undefined) {
      throw new CliError(2, "Choose either --api-key or --api-key-env.");
    }
    if (options.browser && (options.apiKey !== undefined || options.apiKeyEnv !== undefined)) {
      throw new CliError(2, "Choose browser login or an API key.");
    }
    const apiKey = options.apiKeyEnv ? process.env[options.apiKeyEnv] : options.apiKey;
    if (options.apiKeyEnv === undefined && options.apiKey === undefined) {
      if (options.browser || options.mcpUrl || flags.json || flags.quiet) {
        await loginAceTeam(flags, options.mcpUrl);
      } else {
        await runLoginFlow();
      }
      return;
    }
    if (!apiKey?.trim()) throw new CliError(2, "API key is empty.");
    const config = loadConfig();
    const session: ControlPlaneSession = {
      kind: "api_key",
      mcp_url: validateMcpUrl(options.mcpUrl || config.control_plane?.mcp_url || DEFAULT_MCP_URL),
      access_token: apiKey.trim(),
    };
    config.fabric_url = config.fabric_url || "https://app.aceteam.ai";
    config.fabric_api_key = session.access_token;
    saveConfig(config);
    let identity: Record<string, unknown>;
    try {
      identity = await new ControlPlaneClient(session).identity();
    } catch (error) {
      const failure = error instanceof CliError ? error : new CliError(4, "Could not verify the control-plane key.");
      throw new CliError(failure.exitCode, "Fabric key saved, but control-plane login failed: " + failure.message);
    }
    if (typeof identity.organization_id !== "string") {
      throw new CliError(4, "The control plane returned no active organization.");
    }
    session.active_org_id = identity.organization_id;
    config.control_plane = session;
    saveConfig(config);
    printValue(
      { authenticated: true, organization_id: identity.organization_id, user_id: identity.user_id },
      flags,
      () => "Connected to AceTeam. Active organization: " + String(identity.organization_id),
    );
  }, flags);
});

export const logoutCommand = new Command("logout")
  .description("Remove the saved AceTeam control-plane session")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

logoutCommand.action(async () => {
  const flags = outputFlags(logoutCommand);
  await runCli(async () => {
    const config = loadConfig();
    if (config.control_plane?.kind === "api_key" &&
        config.fabric_api_key === config.control_plane.access_token) {
      delete config.fabric_api_key;
    }
    delete config.control_plane;
    saveConfig(config);
    printValue({ authenticated: false }, flags, () => "Saved AceTeam session removed.");
  }, flags);
});
