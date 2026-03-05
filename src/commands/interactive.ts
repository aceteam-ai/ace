import { select, input, confirm, Separator } from "@inquirer/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../utils/config.js";
import {
  listPatterns,
  loadPattern,
  runPattern,
  readInputFile,
} from "../utils/patterns.js";
import { ensurePython } from "../utils/ensure-python.js";
import {
  detectProvider,
  providerLabel,
  type ProviderInfo,
} from "../utils/provider-detect.js";
import { classifyPythonError, classifyWorkflowError } from "../utils/errors.js";
import { TEMPLATES, getTemplateById } from "../templates/index.js";
import { DEMOS } from "../demos/index.js";
import * as output from "../utils/output.js";
import type { PatternDef } from "../patterns/index.js";

// Read version from package.json at build time via import
import pkg from "../../package.json" with { type: "json" };
const VERSION = pkg.version;

export async function startInteractive(): Promise<void> {
  const config = loadConfig();
  const provider = await detectProvider();

  console.log(
    chalk.bold(`\n  AceTeam CLI`) +
      chalk.dim(` v${VERSION}`) +
      "\n" +
      chalk.dim(`  ${providerLabel(provider)}`) +
      "\n"
  );

  // Check if init has been run
  if (!config.python_path) {
    output.warn("Not initialized. Running setup first...\n");
    const { initCommand } = await import("./init.js");
    await initCommand.parseAsync(["node", "ace", "init"]);
  }

  // If no provider configured, prompt login before showing menu
  if (!provider.provider) {
    console.log(chalk.bold("  Welcome! Let's get you connected to an LLM.\n"));
    const { runLoginFlow } = await import("./login.js");
    await runLoginFlow();
  }

  await mainLoop();
}

async function mainLoop(): Promise<void> {
  // H2: Use descriptive labels that match user's mental model
  while (true) {
    const action = await select({
      message: "What would you like to do?",
      choices: [
        { name: "Run a task", value: "run-pattern" },
        { name: "Run a workflow (JSON)", value: "run-workflow" },
        { name: "Create a workflow from template", value: "create-workflow" },
        { name: "View / edit settings", value: "config" },
        { name: "Log in / change provider", value: "login" },
        new Separator(),
        { name: "Exit", value: "exit" },
      ],
    });

    switch (action) {
      case "run-pattern":
        await handleRunPattern();
        break;
      case "run-workflow":
        await handleRunWorkflow();
        break;
      case "create-workflow":
        await handleCreateWorkflow();
        break;
      case "config":
        await handleConfig();
        break;
      case "login": {
        const { runLoginFlow } = await import("./login.js");
        await runLoginFlow();
        break;
      }
      case "exit":
        return;
    }

    console.log();
  }
}

async function handleRunPattern(): Promise<void> {
  // H5: Check provider BEFORE collecting input text
  const provider = await detectProvider();

  const patterns = listPatterns();

  // Group by category for display
  const grouped = new Map<string, PatternDef[]>();
  for (const p of patterns) {
    const group = grouped.get(p.category) || [];
    group.push(p);
    grouped.set(p.category, group);
  }

  // Build choices with category separators
  const choices: Array<
    { name: string; value: string } | InstanceType<typeof Separator>
  > = [];
  for (const [category, categoryPatterns] of grouped) {
    choices.push(
      new Separator(
        chalk.bold(
          `── ${category.charAt(0).toUpperCase() + category.slice(1)} ──`
        )
      )
    );
    for (const p of categoryPatterns) {
      choices.push({
        name: `${p.id.padEnd(22)} ${chalk.dim(p.description)}`,
        value: p.id,
      });
    }
  }

  while (true) {
    const patternId = await select({
      message: "Choose a task:",
      choices,
      pageSize: 15,
    });

    const pattern = loadPattern(patternId);
    if (!pattern) {
      output.error(`Pattern not found: ${patternId}`);
      return;
    }

    // H5: Early check — if no provider, warn before asking for input
    if (!provider.provider) {
      const demo = DEMOS[patternId];
      if (demo) {
        output.warn("No LLM provider configured — showing sample output\n");
        console.log(demo.output);
      } else {
        output.error(
          "No LLM provider configured. Set an API key or start Ollama to run tasks."
        );
        console.log(chalk.dim("\n  export OPENAI_API_KEY=sk-..."));
        console.log(chalk.dim("  export ANTHROPIC_API_KEY=sk-ant-..."));
        console.log(chalk.dim("  ollama serve && ollama pull llama3"));
      }
      return;
    }

    const inputText = await input({
      message: "Enter text (or path to file):",
      validate: (value) => (value.trim() ? true : "Input is required"),
    });

    // Detect file path vs inline text
    let text = inputText.trim();
    if (
      (text.startsWith("/") ||
        text.startsWith("./") ||
        text.startsWith("~/")) &&
      text.indexOf("\n") === -1
    ) {
      try {
        const resolvedPath = text.startsWith("~/")
          ? text.replace("~", (await import("node:os")).homedir())
          : text;
        text = readInputFile(resolvedPath);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const pythonPath = await ensurePython();
    const spinner = ora(`Running ${pattern.name}...`).start();

    try {
      const result = await runPattern(pythonPath, pattern, text, {
        model: provider.model,
      });
      spinner.succeed(`${pattern.name} completed`);
      console.log();
      console.log(result);
    } catch (err) {
      spinner.fail(`${pattern.name} failed`);
      // H9: Use classifyPythonError for actionable messages, same as CLI
      const classified = classifyPythonError(
        err instanceof Error ? err.message : String(err)
      );
      console.error(chalk.red(classified.message));
      if (classified.suggestion) {
        console.error(chalk.dim(classified.suggestion));
      }
    }

    // H3/H12: Loop instead of recursion — bounded stack, clean "back to menu"
    const again = await confirm({
      message: "Run another task?",
      default: true,
    });

    if (!again) return;
  }
}

async function handleRunWorkflow(): Promise<void> {
  // H5: Validate file exists BEFORE asking for inputs
  const file = await input({
    message: "Path to workflow JSON file:",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Path is required";
      if (!existsSync(trimmed)) return `File not found: ${trimmed}`;
      try {
        JSON.parse(readFileSync(trimmed, "utf-8"));
      } catch {
        return `Not valid JSON: ${trimmed}`;
      }
      return true;
    },
  });

  const filePath = file.trim();

  // H6: Read workflow to show required inputs — recognition over recall
  let workflow: Record<string, unknown>;
  try {
    workflow = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    output.error(`Failed to read: ${filePath}`);
    return;
  }

  const workflowInputs = workflow.inputs as
    | Array<{ name: string; description?: string }>
    | undefined;

  const inputs: Record<string, string> = {};

  if (workflowInputs && workflowInputs.length > 0) {
    console.log(chalk.bold("\nWorkflow inputs:\n"));
    for (const wi of workflowInputs) {
      const desc = wi.description ? chalk.dim(` (${wi.description})`) : "";
      const value = await input({
        message: `  ${wi.name}${desc}:`,
        validate: (v) => (v.trim() ? true : `${wi.name} is required`),
      });
      inputs[wi.name] = value.trim();
    }
  }

  const pythonPath = await ensurePython();

  // Pre-validate node types
  const { validateNodeTypes } = await import("../utils/node-cache.js");
  const { invalid, available } = await validateNodeTypes(pythonPath, filePath);
  if (invalid.length > 0) {
    output.error(
      `Unknown node type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`
    );
    if (available.length > 0) {
      console.log(chalk.dim(`  Available: ${available.join(", ")}`));
    }
    return;
  }

  const { runWorkflow } = await import("../utils/python.js");
  const spinner = ora("Running workflow...").start();

  try {
    const result = await runWorkflow(pythonPath, filePath, inputs, {
      onProgress: (event) => {
        if (event.type === "node_running") {
          spinner.text = `Running ${event.nodeName}...`;
        }
      },
    });

    if (result.success) {
      spinner.succeed("Workflow completed");
      console.log();
      console.log(chalk.bold("Output:"));
      console.log(JSON.stringify(result.output, null, 2));
    } else {
      spinner.fail("Workflow failed");
      const classified = classifyWorkflowError(result);
      console.error(chalk.red(classified.message));
      if (classified.suggestion) {
        console.error(chalk.dim(classified.suggestion));
      }
    }
  } catch (err) {
    spinner.fail("Workflow execution error");
    const classified = classifyPythonError(
      err instanceof Error ? err.message : String(err)
    );
    console.error(chalk.red(classified.message));
    if (classified.suggestion) {
      console.error(chalk.dim(classified.suggestion));
    }
  }
}

async function handleCreateWorkflow(): Promise<void> {
  const choices = TEMPLATES.map((t) => ({
    name: `${t.name} ${chalk.dim(`— ${t.description}`)}`,
    value: t.id,
  }));

  const templateId = await select({
    message: "Choose a template:",
    choices,
  });

  const template = getTemplateById(templateId);
  if (!template) {
    output.error(`Template not found: ${templateId}`);
    return;
  }

  const workflow = structuredClone(template.workflow);
  const nodes = ((workflow as Record<string, unknown>).inner_nodes ||
    (workflow as Record<string, unknown>).nodes ||
    []) as Array<{
    id: string;
    type: string;
    params: Record<string, string>;
  }>;

  // Customize parameters
  if (nodes.length > 0) {
    console.log(
      chalk.bold("\nCustomize node parameters (Enter to keep default):\n")
    );

    for (const node of nodes) {
      if (node.params && Object.keys(node.params).length > 0) {
        console.log(`  ${chalk.cyan(node.type)} (${node.id}):`);
        for (const [key, defaultVal] of Object.entries(node.params)) {
          const value = await input({
            message: `  ${key}`,
            default: defaultVal,
          });
          node.params[key] = value;
        }
      }
    }
  }

  const outputPath = await input({
    message: "Output file:",
    default: "workflow.json",
    // H5: Warn before overwriting an existing file
    validate: (value) => {
      if (!value.trim()) return "File path is required";
      return true;
    },
  });

  // H5: Confirm before overwriting
  if (existsSync(outputPath)) {
    const overwrite = await confirm({
      message: `${outputPath} already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      output.info("Cancelled");
      return;
    }
  }

  writeFileSync(outputPath, JSON.stringify(workflow, null, 2) + "\n", "utf-8");

  output.success(`Created ${outputPath}`);

  const inputNames = (workflow.inputs as Array<{ name: string }>).map(
    (i) => i.name
  );
  const inputArgs = inputNames
    .map((name) => `${name}='...'`)
    .join(" --input ");
  console.log(
    chalk.dim(`\nRun: ace run ${outputPath} --input ${inputArgs}`)
  );
}

// H8: Show only user-relevant config, hide internals
async function handleConfig(): Promise<void> {
  const config = loadConfig();
  const provider = await detectProvider();

  console.log(chalk.bold("\nSettings:"));
  console.log(`  Default model:  ${config.default_model || chalk.dim("not set")}`);
  console.log(`  LLM provider:   ${providerLabel(provider)}`);
  console.log(
    `  AceTeam:        ${config.fabric_api_key ? chalk.green("connected") + chalk.dim(` (${config.fabric_url})`) : chalk.dim("not connected")}`
  );

  const edit = await confirm({
    message: "Edit default model?",
    default: false,
  });

  if (edit) {
    const { saveConfig } = await import("../utils/config.js");
    const newModel = await input({
      message: "Default model:",
      default: config.default_model || "gpt-4o-mini",
    });
    config.default_model = newModel;
    saveConfig(config);
    output.success("Configuration saved");
  }
}

