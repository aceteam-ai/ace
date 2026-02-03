import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import {
  findPython,
  isAceteamNodesInstalled,
  installAceteamNodes,
  runWorkflow,
  validateWorkflow,
  listNodes,
} from "../utils/python.js";
import { loadConfig } from "../utils/config.js";
import { FabricClient } from "../utils/fabric.js";
import * as output from "../utils/output.js";

async function ensurePython(): Promise<string> {
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
  .option("-v, --verbose", "Show progress messages")
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
        });

        if (result.success) {
          spinner.succeed("Workflow completed");
          console.log();
          console.log(chalk.bold("Output:"));
          console.log(JSON.stringify(result.output, null, 2));
        } else {
          spinner.fail("Workflow failed");
          if (result.errors) {
            console.error(
              chalk.red(JSON.stringify(result.errors, null, 2))
            );
          }
          if (result.error) {
            console.error(chalk.red(result.error));
          }
          process.exit(1);
        }
      } catch (err) {
        spinner.fail("Workflow execution error");
        console.error(chalk.red(String(err)));
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
