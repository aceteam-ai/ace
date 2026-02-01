import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import chalk from "chalk";
import { getConfigPath, loadConfig, saveConfig } from "../utils/config.js";
import { findPython, installAceteamNodes, isAceteamNodesInstalled } from "../utils/python.js";
import * as output from "../utils/output.js";

export const initCommand = new Command("init")
  .description("Initialize AceTeam CLI configuration")
  .action(async () => {
    const configPath = getConfigPath();
    const rl = createInterface({ input: stdin, output: stdout });

    console.log(chalk.bold("\nAceTeam CLI Setup\n"));

    // Check Python
    console.log("Checking Python installation...");
    const pythonPath = await findPython();
    if (!pythonPath) {
      output.error(
        "Python 3.12+ not found. Please install Python 3.12 or later."
      );
      rl.close();
      process.exit(1);
    }
    output.success(`Python found: ${pythonPath}`);

    // Check aceteam-nodes
    console.log("Checking aceteam-nodes...");
    if (isAceteamNodesInstalled(pythonPath)) {
      output.success("aceteam-nodes is installed");
    } else {
      output.warn("aceteam-nodes is not installed");
      const answer = await rl.question(
        "Install aceteam-nodes now? (Y/n) "
      );
      if (answer.toLowerCase() !== "n") {
        console.log("Installing aceteam-nodes...");
        try {
          installAceteamNodes(pythonPath);
          output.success("aceteam-nodes installed");
        } catch {
          output.error(
            "Failed to install aceteam-nodes. Try: pip install aceteam-nodes"
          );
        }
      }
    }

    // Config file
    if (existsSync(configPath)) {
      output.info(`Config file already exists: ${configPath}`);
      const existing = loadConfig();
      console.log(
        `  Current model: ${existing.default_model || "(not set)"}`
      );
    } else {
      console.log(`\nCreating config file: ${configPath}`);
      const model = await rl.question(
        `Default model [gpt-4o-mini]: `
      );
      const config = {
        default_model: model.trim() || "gpt-4o-mini",
      };
      saveConfig(config);
      output.success(`Config saved to ${configPath}`);
    }

    // API key reminder
    console.log(
      "\n" +
        chalk.bold("API Keys:") +
        "\n  Set your API key as an environment variable:" +
        "\n  " +
        chalk.dim("export OPENAI_API_KEY=sk-...") +
        "\n  " +
        chalk.dim("export ANTHROPIC_API_KEY=sk-ant-...") +
        "\n"
    );

    output.success("Setup complete! Try: ace workflow run <file.json>");
    rl.close();
  });
