import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getConfigPath, loadConfig, saveConfig } from "../utils/config.js";
import {
  findPython,
  getPythonVersion,
  createVenv,
  getVenvPythonPath,
  isVenvValid,
  installAceteamNodes,
  isAceteamNodesInstalled,
} from "../utils/python.js";
import * as output from "../utils/output.js";

const DEFAULT_VENV_DIR = join(homedir(), ".ace", "venv");

export const initCommand = new Command("init")
  .description("Initialize AceTeam CLI configuration")
  .action(async () => {
    const configPath = getConfigPath();
    const rl = createInterface({ input: stdin, output: stdout });

    console.log(chalk.bold("\nAceTeam CLI Setup\n"));

    // Step 1: Prerequisites — detect Python
    console.log(chalk.bold("1. Prerequisites"));
    const systemPython = await findPython();

    if (!systemPython) {
      // Try to find any Python to give a better error
      const candidates = ["python3", "python"];
      for (const name of candidates) {
        try {
          const { execSync } = await import("node:child_process");
          const version = execSync(`${name} --version`, {
            encoding: "utf-8",
          }).trim();
          const match = version.match(/Python (\d+\.\d+)/);
          if (match) {
            output.error(
              `Found ${version} at ${name}. Python 3.12+ required.`
            );
            rl.close();
            process.exit(1);
          }
        } catch {
          // Not found
        }
      }

      output.error(
        "Python not found. Please install Python 3.12 or later."
      );
      rl.close();
      process.exit(1);
    }

    const version = getPythonVersion(systemPython);
    const versionStr = version
      ? `${version.major}.${version.minor}.${version.patch}`
      : "unknown";
    output.success(`Python ${versionStr} (${systemPython})`);

    // Step 2: Venv setup
    console.log(chalk.bold("\n2. Virtual environment"));

    const config = existsSync(configPath) ? loadConfig() : {};
    const venvDir = config.venv_dir || DEFAULT_VENV_DIR;

    if (isVenvValid(venvDir)) {
      const venvPython = getVenvPythonPath(venvDir);
      output.success(`Existing venv: ${venvDir}`);
      config.venv_dir = venvDir;
      config.python_path = venvPython;
    } else {
      const spinner = ora(`Creating venv at ${venvDir}...`).start();
      try {
        createVenv(systemPython, venvDir);
        const venvPython = getVenvPythonPath(venvDir);
        config.venv_dir = venvDir;
        config.python_path = venvPython;
        spinner.succeed(`Created venv: ${venvDir}`);
      } catch (err) {
        spinner.fail("Failed to create virtual environment");
        output.error(String(err));
        rl.close();
        process.exit(1);
      }
    }

    // Step 3: Install aceteam-nodes
    console.log(chalk.bold("\n3. Dependencies"));

    const venvPython = config.python_path!;

    if (isAceteamNodesInstalled(venvPython)) {
      output.success("aceteam-nodes is installed");
    } else {
      const spinner = ora("Installing aceteam-nodes...").start();
      try {
        installAceteamNodes(venvPython);
        spinner.succeed("aceteam-nodes installed");
      } catch {
        spinner.fail("Failed to install aceteam-nodes");
        output.error("Try manually: pip install aceteam-nodes");
        rl.close();
        process.exit(1);
      }
    }

    // Step 4: Configure
    console.log(chalk.bold("\n4. Configuration"));

    if (!config.default_model) {
      const model = await rl.question(`Default model [gpt-4o-mini]: `);
      config.default_model = model.trim() || "gpt-4o-mini";
    } else {
      output.info(`Default model: ${config.default_model}`);
    }

    saveConfig(config);

    // Step 5: Summary
    console.log(chalk.bold("\nSetup complete:"));
    console.log(
      `  ${chalk.green("✓")} Python ${versionStr} (${config.python_path})`
    );
    console.log(`  ${chalk.green("✓")} aceteam-nodes installed`);
    console.log(`  ${chalk.green("✓")} Config: ${configPath}`);
    console.log(`  ${chalk.green("✓")} Model: ${config.default_model}`);

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

    console.log(chalk.dim("Try: ace workflow list-templates"));

    rl.close();
  });
