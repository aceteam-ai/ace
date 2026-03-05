import { Command } from "commander";
import { select, input, password } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import { loadConfig, saveConfig } from "../utils/config.js";
import { detectOllama } from "../utils/provider-detect.js";
import * as output from "../utils/output.js";

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
      await loginAceTeam();
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

async function loginAceTeam(): Promise<void> {
  console.log(
    chalk.dim("\n  Get your API key from https://app.aceteam.ai\n")
  );

  const apiKey = await password({
    message: "AceTeam API key:",
    validate: (v) => (v.trim() ? true : "API key is required"),
  });

  const config = loadConfig();
  const url = config.fabric_url || "https://app.aceteam.ai";

  const spinner = ora("Verifying connection...").start();
  try {
    const { FabricClient } = await import("../utils/fabric.js");
    const client = new FabricClient(url, apiKey.trim());
    await client.status();
    spinner.succeed("Connected to AceTeam Cloud");

    config.fabric_url = url;
    config.fabric_api_key = apiKey.trim();
    saveConfig(config);
    output.success("Credentials saved");
  } catch {
    spinner.fail("Connection failed");
    output.warn(
      "Could not verify the key. Saving it anyway — you can retry with `ace login`."
    );
    config.fabric_url = url;
    config.fabric_api_key = apiKey.trim();
    saveConfig(config);
  }
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
  .description("Configure LLM provider (AceTeam, API key, or Ollama)")
  .option("--api-key <key>", "Set AceTeam API key non-interactively")
  .action(async (options: { apiKey?: string }) => {
    if (options.apiKey) {
      const config = loadConfig();
      config.fabric_url = config.fabric_url || "https://app.aceteam.ai";
      config.fabric_api_key = options.apiKey;
      saveConfig(config);
      output.success("AceTeam API key saved");
      return;
    }

    await runLoginFlow();
  });
