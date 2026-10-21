import { Command } from "commander";
import { select, password } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, saveConfig } from "../utils/config.js";
import { detectOllama } from "../utils/provider-detect.js";
import * as output from "../utils/output.js";
import { CliError, ControlPlaneClient, DEFAULT_MCP_URL } from "../utils/control-plane.js";
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
        name: "AceTeam Cloud",
        value: "aceteam",
        description: "Log in for managed LLM access",
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
    case "aceteam":
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

async function loginAceTeam(flags: OutputFlags, mcpUrl?: string): Promise<void> {
  const config = loadConfig();
  const session = await browserLogin(
    mcpUrl || config.control_plane?.mcp_url || DEFAULT_MCP_URL,
    (url) => console.error("Open this URL to authorize Ace: " + url),
  );
  const identity = await new ControlPlaneClient(session).identity();
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
  .description("Connect Ace to the AceTeam control plane")
  .option("--api-key <key>", "Use an API key for one organization")
  .option("--api-key-env <name>", "Read a single-org API key from an environment variable")
  .option("--mcp-url <url>", "Control-plane MCP URL")
  .option("--json", "Output JSON")
  .option("--quiet", "Suppress successful output");

loginCommand.action(async (options: { apiKey?: string; apiKeyEnv?: string; mcpUrl?: string }) => {
  const flags = outputFlags(loginCommand);
  await runCli(async () => {
    if (options.apiKey !== undefined && options.apiKeyEnv !== undefined) {
      throw new CliError(2, "Choose either --api-key or --api-key-env.");
    }
    const apiKey = options.apiKeyEnv ? process.env[options.apiKeyEnv] : options.apiKey;
    if (options.apiKeyEnv === undefined && options.apiKey === undefined) {
      await loginAceTeam(flags, options.mcpUrl);
      return;
    }
    if (!apiKey?.trim()) throw new CliError(2, "API key is empty.");
    const config = loadConfig();
    const session = {
      kind: "api_key" as const,
      mcp_url: options.mcpUrl || config.control_plane?.mcp_url || DEFAULT_MCP_URL,
      access_token: apiKey.trim(),
    };
    const identity = await new ControlPlaneClient(session).identity();
    config.control_plane = session;
    config.fabric_url = config.fabric_url || "https://app.aceteam.ai";
    config.fabric_api_key = session.access_token;
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
