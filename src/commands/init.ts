import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { getConfigPath, loadConfig, saveConfig } from "../utils/config.js";
import {
  findPython,
  findUv,
  getPythonVersion,
  createVenv,
  getVenvPythonPath,
  isVenvValid,
  installAceteamNodes,
  isAceteamNodesInstalled,
} from "../utils/python.js";
import { detectProvider, providerLabel } from "../utils/provider-detect.js";
import { DEMOS } from "../demos/index.js";
import * as output from "../utils/output.js";

const DEFAULT_VENV_DIR = join(homedir(), ".ace", "venv");

// ── Exported setup functions (reusable by TUI) ──────────────

export async function setupPython(): Promise<{
  pythonPath: string | null;
  version: string;
  hasUv: boolean;
}> {
  const uvPath = await findUv();
  const systemPython = await findPython();

  if (!systemPython && !uvPath) {
    // Try to find any Python to give a better error
    const candidates = ["python3", "python"];
    for (const name of candidates) {
      try {
        const { execFileSync } = await import("node:child_process");
        const ver = execFileSync(name, ["--version"], {
          encoding: "utf-8",
        }).trim();
        const match = ver.match(/Python (\d+\.\d+)/);
        if (match) {
          throw new Error(
            `Found ${ver} at ${name}. Python 3.12+ required (or install uv: https://docs.astral.sh/uv/).`
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Python 3.12+")) {
          throw err;
        }
      }
    }
    throw new Error(
      "Neither Python 3.12+ nor uv found.\n" +
        "  Install uv (recommended): curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
        "  Or install Python 3.12+:  https://www.python.org/downloads/"
    );
  }

  if (systemPython) {
    const version = getPythonVersion(systemPython);
    const versionStr = version
      ? `${version.major}.${version.minor}.${version.patch}`
      : "unknown";
    return { pythonPath: systemPython, version: versionStr, hasUv: !!uvPath };
  }

  // uv available but no system Python — uv will provision Python
  return { pythonPath: null, version: "managed by uv", hasUv: true };
}

export async function setupVenv(
  systemPython: string | null,
  venvDir: string = DEFAULT_VENV_DIR
): Promise<{ venvDir: string; venvPython: string }> {
  if (isVenvValid(venvDir)) {
    return { venvDir, venvPython: getVenvPythonPath(venvDir) };
  }

  await createVenv(systemPython, venvDir);
  return { venvDir, venvPython: getVenvPythonPath(venvDir) };
}

export async function installDeps(venvPython: string): Promise<void> {
  if (!isAceteamNodesInstalled(venvPython)) {
    await installAceteamNodes(venvPython);
  }
}

// ── Init command ─────────────────────────────────────────────

export const initCommand = new Command("init")
  .description("Initialize AceTeam CLI configuration")
  .action(async () => {
    const configPath = getConfigPath();
    const rl = createInterface({ input: stdin, output: stdout });

    console.log(chalk.bold("\nAceTeam CLI Setup\n"));

    // Step 1: Prerequisites — detect toolchain
    console.log(chalk.bold("1. Prerequisites"));
    let systemPython: string | null;
    let versionStr: string;
    let hasUv: boolean;

    try {
      const result = await setupPython();
      systemPython = result.pythonPath;
      versionStr = result.version;
      hasUv = result.hasUv;

      if (hasUv) {
        output.success(`uv detected (fast package manager)`);
      }
      if (systemPython) {
        output.success(`Python ${versionStr} (${systemPython})`);
      } else {
        output.info(`Python will be provisioned by uv`);
      }
    } catch (err) {
      output.error(err instanceof Error ? err.message : String(err));
      rl.close();
      process.exit(1);
    }

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
        await createVenv(systemPython, venvDir);
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
      const method = hasUv ? "uv" : "pip";
      const spinner = ora(
        `Installing aceteam-nodes via ${method}...`
      ).start();
      try {
        await installAceteamNodes(venvPython);
        spinner.succeed("aceteam-nodes installed");
      } catch {
        spinner.fail("Failed to install aceteam-nodes");
        if (hasUv) {
          output.error("Try manually: uv pip install aceteam-nodes");
        } else {
          output.error("Try manually: pip install aceteam-nodes");
        }
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

    // Create patterns directory for user-defined patterns
    const patternsDir = join(homedir(), ".ace", "patterns");
    if (!existsSync(patternsDir)) {
      mkdirSync(patternsDir, { recursive: true });
    }

    // Step 5: Provider detection & tiered on-ramp
    console.log(chalk.bold("\n5. LLM Provider"));

    const provider = await detectProvider();

    if (provider.provider === "aceteam") {
      output.success(
        `Connected to AceTeam Fabric — full node support available`
      );
      console.log(chalk.dim(`  ${providerLabel(provider)}`));
    } else if (
      provider.provider === "openai" ||
      provider.provider === "anthropic"
    ) {
      output.success(`Using ${providerLabel(provider)}`);
    } else if (provider.provider === "ollama") {
      output.success(`Ollama detected — ${provider.model}`);
    } else {
      output.warn("No LLM provider detected");
      console.log(
        "\n" +
          chalk.bold("  Set up a provider to run tasks:") +
          "\n" +
          "\n" +
          `  ${chalk.cyan("Tier 1 — Free / Local")}` +
          "\n" +
          `  ${chalk.dim("ollama serve && ollama pull llama3")}` +
          "\n" +
          "\n" +
          `  ${chalk.cyan("Tier 2 — Bring Your Own Key")}` +
          "\n" +
          `  ${chalk.dim("export OPENAI_API_KEY=sk-...")}` +
          "\n" +
          `  ${chalk.dim("export ANTHROPIC_API_KEY=sk-ant-...")}` +
          "\n" +
          "\n" +
          `  ${chalk.cyan("Tier 3 — AceTeam Platform")}` +
          "\n" +
          `  ${chalk.dim("ace login           # Full node support + remote execution")}`
      );
    }

    // Done — offer demo
    console.log(chalk.bold("\n\nSetup complete.\n"));
    const wantDemo = await rl.question(
      chalk.bold("Want to try a quick demo? ") + chalk.dim("(Y/n) ")
    );

    if (wantDemo.trim().toLowerCase() !== "n") {
      if (provider.provider) {
        // Live demo
        console.log();
        output.info(
          `Running: ${chalk.cyan('ace run explain "What is quantum computing?"')}`
        );
        console.log();

        try {
          const { ensurePython } = await import("../utils/ensure-python.js");
          const { loadPattern, runPattern } = await import(
            "../utils/patterns.js"
          );
          const pythonPath = await ensurePython();
          const pattern = loadPattern("explain");

          if (pattern) {
            const spinner = ora("Running explain pattern...").start();
            const result = await runPattern(
              pythonPath,
              pattern,
              "What is quantum computing?",
              { model: provider.model }
            );
            spinner.succeed("Done!");
            console.log();
            console.log(result);
          }
        } catch (err) {
          output.warn(
            `Live demo failed: ${err instanceof Error ? err.message : String(err)}`
          );
          showCannedDemo();
        }
      } else {
        // Canned demo
        showCannedDemo();
      }
    }

    console.log(
      "\n" +
        chalk.dim("─".repeat(50)) +
        "\n" +
        chalk.bold("Next steps:") +
        "\n" +
        `  ${chalk.cyan("ace run --list")}        List available tasks` +
        "\n" +
        `  ${chalk.cyan("ace run summarize")}     Run a task on text` +
        "\n" +
        `  ${chalk.cyan("ace")}                   Launch interactive mode` +
        "\n"
    );

    rl.close();
  });

function showCannedDemo(): void {
  const demo = DEMOS["explain"];
  if (!demo) return;

  console.log();
  console.log(
    chalk.dim("  Here's what ") +
      chalk.cyan("ace run explain") +
      chalk.dim(" produces:")
  );
  console.log(chalk.dim("  Input: ") + chalk.white(`"${demo.input}"`));
  console.log();

  // Indent demo output
  const lines = demo.output.split("\n");
  for (const line of lines) {
    console.log(`  ${line}`);
  }
}
