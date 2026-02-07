import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import ora from "ora";
import {
  findPython,
  isAceteamNodesInstalled,
  installAceteamNodes,
  runWorkflow,
  validateWorkflow,
  listNodes,
  getVenvPythonPath,
  isVenvValid,
} from "../utils/python.js";
import { loadConfig } from "../utils/config.js";
import { FabricClient } from "../utils/fabric.js";
import { classifyPythonError } from "../utils/errors.js";
import { TEMPLATES, getTemplateById } from "../templates/index.js";
import * as output from "../utils/output.js";

async function ensurePython(): Promise<string> {
  const config = loadConfig();

  // Check config python_path first (managed venv)
  if (config.python_path && existsSync(config.python_path)) {
    if (isAceteamNodesInstalled(config.python_path)) {
      return config.python_path;
    }
  }

  // Check managed venv
  if (config.venv_dir && isVenvValid(config.venv_dir)) {
    const venvPython = getVenvPythonPath(config.venv_dir);
    if (isAceteamNodesInstalled(venvPython)) {
      return venvPython;
    }
  }

  // Fallback to PATH detection
  const pythonPath = await findPython();
  if (!pythonPath) {
    output.error(
      "Python 3.12+ not found. Please install Python and run: ace init"
    );
    process.exit(1);
  }

  if (!isAceteamNodesInstalled(pythonPath)) {
    output.warn("aceteam-nodes is not installed.");
    console.log("Installing aceteam-nodes...");
    try {
      installAceteamNodes(pythonPath);
      output.success("aceteam-nodes installed");
    } catch {
      output.error(
        "Failed to install aceteam-nodes. Try: pip install aceteam-nodes"
      );
      process.exit(1);
    }
  }

  return pythonPath;
}

function parseInputArgs(inputs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of inputs) {
    const eqIndex = item.indexOf("=");
    if (eqIndex === -1) {
      output.error(`Invalid input format: ${item}. Use key=value`);
      process.exit(1);
    }
    result[item.slice(0, eqIndex)] = item.slice(eqIndex + 1);
  }
  return result;
}

async function runRemoteWorkflow(
  file: string,
  input: Record<string, string>
): Promise<void> {
  const config = loadConfig();
  if (!config.fabric_url || !config.fabric_api_key) {
    output.error(
      "Fabric not configured. Run: ace fabric login"
    );
    process.exit(1);
  }

  const client = new FabricClient(config.fabric_url, config.fabric_api_key);

  const discoverSpinner = ora("Discovering available nodes...").start();
  try {
    const nodes = (await client.discover()) as Array<Record<string, unknown>>;
    if (!Array.isArray(nodes) || nodes.length === 0) {
      discoverSpinner.fail("No remote nodes available");
      process.exit(1);
    }
    discoverSpinner.succeed(
      `Found ${nodes.length} node${nodes.length === 1 ? "" : "s"}`
    );
  } catch (err) {
    discoverSpinner.fail("Failed to discover nodes");
    output.error(String(err));
    process.exit(1);
  }

  const workflow = JSON.parse(readFileSync(file, "utf-8"));

  const runSpinner = ora("Enqueuing workflow on Fabric...").start();
  try {
    const result = (await client.enqueueWorkflow(workflow, input)) as Record<
      string,
      unknown
    >;
    runSpinner.succeed("Workflow enqueued");

    console.log();
    console.log(chalk.bold("Result:"));
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    runSpinner.fail("Remote workflow execution failed");
    output.error(String(err));
    process.exit(1);
  }
}

export const workflowCommand = new Command("workflow")
  .description("Workflow operations");

workflowCommand
  .command("run <file>")
  .description("Run a workflow from a JSON file")
  .option("-i, --input <key=value...>", "Input values", [])
  .option("-v, --verbose", "Show raw stderr debug output")
  .option("--config <path>", "Config file path")
  .option("--remote", "Run on remote Fabric node instead of locally")
  .action(
    async (
      file: string,
      options: {
        input: string[];
        verbose?: boolean;
        config?: string;
        remote?: boolean;
      }
    ) => {
      // Check file exists
      if (!existsSync(file)) {
        output.error(`File not found: ${file}`);
        process.exit(1);
      }

      // Validate it's parseable JSON
      try {
        JSON.parse(readFileSync(file, "utf-8"));
      } catch {
        output.error(`Invalid JSON file: ${file}`);
        process.exit(1);
      }

      const input = parseInputArgs(options.input);

      // Remote execution via Fabric
      if (options.remote) {
        await runRemoteWorkflow(file, input);
        return;
      }

      // Local execution via Python
      const pythonPath = await ensurePython();

      const spinner = ora("Running workflow...").start();

      try {
        const result = await runWorkflow(pythonPath, file, input, {
          verbose: options.verbose,
          config: options.config,
          onProgress: (event) => {
            switch (event.type) {
              case "started":
                spinner.text = `Running workflow (${event.totalNodes} nodes)...`;
                break;
              case "node_running":
                if (event.totalNodes && event.currentNode) {
                  spinner.text = `Running node ${event.currentNode}/${event.totalNodes}: ${event.nodeName}...`;
                } else {
                  spinner.text = `Running ${event.nodeName}...`;
                }
                break;
              case "node_done":
                // Keep spinner going, text will update on next event
                break;
              case "node_error":
                spinner.text = `Error in ${event.nodeName}: ${event.message}`;
                break;
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

          const rawError =
            result.error ||
            (result.errors ? JSON.stringify(result.errors) : "Unknown error");
          const classified = classifyPythonError(rawError);

          console.error(chalk.red(classified.message));
          if (classified.suggestion) {
            console.error(chalk.dim(classified.suggestion));
          }
          process.exit(1);
        }
      } catch (err) {
        spinner.fail("Workflow execution error");

        const classified = classifyPythonError(String(err));
        console.error(chalk.red(classified.message));
        if (classified.suggestion) {
          console.error(chalk.dim(classified.suggestion));
        }
        process.exit(1);
      }
    }
  );

workflowCommand
  .command("validate <file>")
  .description("Validate a workflow JSON file")
  .action(async (file: string) => {
    if (!existsSync(file)) {
      output.error(`File not found: ${file}`);
      process.exit(1);
    }

    // Quick JSON check (no Python needed)
    let jsonData: unknown;
    try {
      jsonData = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      output.error(`Invalid JSON: ${file}`);
      process.exit(1);
    }

    // Basic structural checks (TypeScript-only)
    if (
      typeof jsonData !== "object" ||
      jsonData === null ||
      !("nodes" in jsonData) ||
      !("inputs" in jsonData) ||
      !("outputs" in jsonData)
    ) {
      output.error(
        "Invalid workflow: missing required fields (nodes, inputs, outputs)"
      );
      process.exit(1);
    }

    // Full validation via Python
    const pythonPath = await ensurePython();
    const result = await validateWorkflow(pythonPath, file);

    if (result.valid) {
      output.success("Valid workflow");
      console.log(
        `  Nodes: ${result.nodes}, Inputs: ${JSON.stringify(result.inputs)}, Outputs: ${JSON.stringify(result.outputs)}`
      );
    } else {
      output.error(`Invalid workflow: ${result.error}`);
      process.exit(1);
    }
  });

workflowCommand
  .command("list-nodes")
  .description("List available node types")
  .action(async () => {
    const pythonPath = await ensurePython();
    const result = await listNodes(pythonPath);

    if ("error" in result) {
      output.error(`Failed to list nodes: ${result.error}`);
      process.exit(1);
    }

    const nodes = result.nodes as Array<{
      type: string;
      display_name: string;
      description: string;
    }>;

    output.printTable(
      ["Type", "Name", "Description"],
      nodes.map((n) => [n.type, n.display_name, n.description])
    );
  });

workflowCommand
  .command("list-templates")
  .description("List available workflow templates")
  .option("--category <name>", "Filter by category")
  .action((options: { category?: string }) => {
    let templates = TEMPLATES;

    if (options.category) {
      const cat = options.category.toLowerCase();
      templates = templates.filter((t) => t.category.toLowerCase() === cat);
    }

    if (templates.length === 0) {
      output.warn("No templates found");
      if (options.category) {
        const categories = [...new Set(TEMPLATES.map((t) => t.category))];
        console.log(`  Available categories: ${categories.join(", ")}`);
      }
      return;
    }

    output.printTable(
      ["ID", "Name", "Category", "Inputs"],
      templates.map((t) => [
        t.id,
        t.name,
        t.category,
        t.inputs.join(", "),
      ])
    );
  });

workflowCommand
  .command("create [template-id]")
  .description("Create a workflow from a template")
  .option("-o, --output <file>", "Output file path", "workflow.json")
  .action(async (templateId: string | undefined, options: { output: string }) => {
    const rl = createInterface({ input: stdin, output: stdout });

    try {
      // If no template ID, show list and prompt
      if (!templateId) {
        console.log(chalk.bold("\nAvailable templates:\n"));
        TEMPLATES.forEach((t, i) => {
          console.log(`  ${chalk.cyan(`${i + 1})`)} ${t.name} ${chalk.dim(`- ${t.description}`)}`);
        });
        console.log();

        const answer = await rl.question("Select template (number): ");
        const index = parseInt(answer, 10) - 1;

        if (isNaN(index) || index < 0 || index >= TEMPLATES.length) {
          output.error("Invalid selection");
          return;
        }

        templateId = TEMPLATES[index].id;
      }

      const template = getTemplateById(templateId);
      if (!template) {
        output.error(`Template not found: ${templateId}`);
        const ids = TEMPLATES.map((t) => t.id).join(", ");
        console.log(`  Available: ${ids}`);
        return;
      }

      // Load template workflow JSON
      const workflow = structuredClone(template.workflow);

      // Prompt for node parameter customization
      const nodes = workflow.nodes as Array<{
        id: string;
        type: string;
        params: Record<string, string>;
      }>;

      if (nodes.length > 0) {
        console.log(chalk.bold("\nCustomize node parameters (Enter to keep default):\n"));

        for (const node of nodes) {
          if (node.params && Object.keys(node.params).length > 0) {
            console.log(`  ${chalk.cyan(node.type)} (${node.id}):`);
            for (const [key, defaultVal] of Object.entries(node.params)) {
              const answer = await rl.question(
                `    ${key} [${defaultVal}]: `
              );
              if (answer.trim()) {
                node.params[key] = answer.trim();
              }
            }
          }
        }
      }

      // Write output
      const outputPath = options.output;
      writeFileSync(outputPath, JSON.stringify(workflow, null, 2) + "\n", "utf-8");

      output.success(`Created ${outputPath}`);

      // Build a helpful run command
      const inputNames = (workflow.inputs as Array<{ name: string }>).map(
        (i) => i.name
      );
      const inputArgs = inputNames
        .map((name) => `${name}='...'`)
        .join(" --input ");

      console.log(
        chalk.dim(`\nRun: ace workflow run ${outputPath} --input ${inputArgs}`)
      );
    } finally {
      rl.close();
    }
  });
