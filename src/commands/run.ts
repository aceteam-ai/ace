import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { ensurePython } from "../utils/ensure-python.js";
import {
  listPatterns,
  loadPattern,
  readStdin,
  readInputFile,
  runPattern,
  runBatch,
  writeOutput,
  getUserPatternsDir,
} from "../utils/patterns.js";
import {
  runWorkflow,
} from "../utils/python.js";
import { loadConfig } from "../utils/config.js";
import { FabricClient } from "../utils/fabric.js";
import { classifyPythonError, classifyWorkflowError } from "../utils/errors.js";
import { validateNodeTypes } from "../utils/node-cache.js";
import * as output from "../utils/output.js";

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

function isWorkflowFile(name: string): boolean {
  return name.endsWith(".json");
}

export const runCommand = new Command("run")
  .description("Run a task or workflow (auto-detects .json files)")
  .argument("[pattern]", "Task name or workflow .json file")
  .argument("[text]", "Inline text input (task mode only)")
  .option("-l, --list", "List available tasks")
  .option("--info <pattern>", "Show task details")
  .option("-m, --model <model>", "Override the LLM model")
  .option("-j, --json", "Output as JSON")
  .option("-v, --verbose", "Show debug output")
  .option("-f, --file <path>", "Read input from a file")
  .option("--input-dir <path>", "Process all files in a directory")
  .option("-o, --output <path>", "Write output to a file")
  .option("--output-dir <path>", "Write batch outputs to a directory")
  .option("-i, --input <key=value...>", "Input values (workflow mode)", [])
  .option("--config <path>", "Config file path (workflow mode)")
  .option("--remote", "Run on remote Fabric node (workflow mode)")
  .action(
    async (
      patternName: string | undefined,
      inlineText: string | undefined,
      options: {
        list?: boolean;
        info?: string;
        model?: string;
        json?: boolean;
        verbose?: boolean;
        file?: string;
        inputDir?: string;
        output?: string;
        outputDir?: string;
        input: string[];
        config?: string;
        remote?: boolean;
      }
    ) => {
      // ── List patterns ──────────────────────────────────
      if (options.list) {
        const patterns = listPatterns();
        const grouped = new Map<string, typeof patterns>();
        for (const p of patterns) {
          const group = grouped.get(p.category) || [];
          group.push(p);
          grouped.set(p.category, group);
        }

        for (const [category, categoryPatterns] of grouped) {
          console.log(chalk.bold(`\n${category.charAt(0).toUpperCase() + category.slice(1)}`));
          for (const p of categoryPatterns) {
            console.log(`  ${chalk.cyan(p.id.padEnd(22))} ${p.description}`);
          }
        }

        console.log(chalk.dim(`\nUser tasks: ${getUserPatternsDir()}`));
        return;
      }

      // ── Pattern info ───────────────────────────────────
      if (options.info) {
        const pattern = loadPattern(options.info);
        if (!pattern) {
          output.error(`Task not found: ${options.info}`);
          const all = listPatterns();
          console.log(chalk.dim(`Available: ${all.map((p) => p.id).join(", ")}`));
          process.exit(1);
        }

        console.log(chalk.bold(pattern.name));
        console.log(chalk.dim(pattern.description));
        console.log();
        console.log(chalk.bold("Category:"), pattern.category);
        if (pattern.model) {
          console.log(chalk.bold("Model:"), pattern.model);
        }
        console.log();
        console.log(chalk.bold("System Prompt:"));
        console.log(chalk.dim("─".repeat(60)));
        console.log(pattern.systemPrompt);
        console.log(chalk.dim("─".repeat(60)));
        return;
      }

      // ── Validate argument ──────────────────────────────
      if (!patternName) {
        output.error("Task name or workflow file required. Use --list to see available tasks.");
        console.log(chalk.dim("Usage: ace run <task> [text]"));
        console.log(chalk.dim("       ace run workflow.json --input key=value"));
        console.log(chalk.dim("       echo \"text\" | ace run <task>"));
        process.exit(1);
      }

      // ── Workflow mode (.json file) ─────────────────────
      if (isWorkflowFile(patternName)) {
        if (!existsSync(patternName)) {
          output.error(`File not found: ${patternName}`);
          process.exit(1);
        }

        try {
          JSON.parse(readFileSync(patternName, "utf-8"));
        } catch {
          output.error(`Invalid JSON file: ${patternName}`);
          process.exit(1);
        }

        const workflowInput = parseInputArgs(options.input);

        if (options.remote) {
          await runRemoteWorkflow(patternName, workflowInput);
          return;
        }

        const pythonPath = await ensurePython();

        const { invalid, available } = await validateNodeTypes(
          pythonPath,
          patternName
        );
        if (invalid.length > 0) {
          output.error(
            `Unknown node type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`
          );
          if (available.length > 0) {
            console.log(
              chalk.dim(`  Available: ${available.join(", ")}`)
            );
          }
          console.log(
            chalk.dim("  Run 'ace workflow list-nodes' for all available types")
          );
          process.exit(1);
        }

        const spinner = ora("Running workflow...").start();

        try {
          const result = await runWorkflow(pythonPath, patternName, workflowInput, {
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

            const classified = classifyWorkflowError(result);

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

        return;
      }

      // ── Task mode ──────────────────────────────────────
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(patternName)) {
        output.error("Invalid task name. Use only letters, numbers, hyphens, and underscores.");
        process.exit(1);
      }

      const pattern = loadPattern(patternName);
      if (!pattern) {
        output.error(`Task not found: ${patternName}`);
        const all = listPatterns();
        console.log(chalk.dim(`Available: ${all.map((p) => p.id).join(", ")}`));
        process.exit(1);
      }

      // ── Ensure Python + aceteam-nodes ──────────────────
      const pythonPath = await ensurePython();

      // ── Batch mode (folder → folder) ──────────────────
      if (options.inputDir) {
        if (!options.outputDir) {
          output.error("--output-dir is required with --input-dir");
          process.exit(1);
        }

        await runBatch(pythonPath, pattern, options.inputDir, {
          outputDir: options.outputDir,
          model: options.model,
          json: options.json,
          verbose: options.verbose,
        });
        return;
      }

      // ── Resolve input text ─────────────────────────────
      // Priority: --file > inline text arg > stdin pipe
      let inputText: string;

      if (options.file) {
        try {
          inputText = readInputFile(options.file);
        } catch (err) {
          output.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      } else if (inlineText) {
        inputText = inlineText;
      } else {
        inputText = await readStdin();
      }

      if (!inputText) {
        output.error("No input provided.");
        console.log(chalk.dim("Usage: ace run <task> \"text to process\""));
        console.log(chalk.dim("       ace run <task> --file input.txt"));
        console.log(chalk.dim("       echo \"text\" | ace run <task>"));
        process.exit(1);
      }

      // ── Execute pattern via aceteam-nodes ──────────────
      const spinner = ora(`Running ${pattern.name}...`).start();

      try {
        const result = await runPattern(pythonPath, pattern, inputText, {
          model: options.model,
          json: options.json,
          verbose: options.verbose,
        });

        spinner.stop();
        writeOutput(result, options.output);

        if (options.output) {
          output.success(`Output written to ${options.output}`);
        }
      } catch (err) {
        spinner.fail(`${pattern.name} failed`);
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(message));
        process.exit(1);
      }
    }
  );
