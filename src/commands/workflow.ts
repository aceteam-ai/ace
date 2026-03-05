import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import {
  validateWorkflow,
  listNodes,
} from "../utils/python.js";
import { validateNodeTypes } from "../utils/node-cache.js";
import { TEMPLATES, getTemplateById } from "../templates/index.js";
import * as output from "../utils/output.js";
import { ensurePython } from "../utils/ensure-python.js";

export const workflowCommand = new Command("workflow")
  .description("Workflow authoring and validation");

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
    // Support both v2 (input_node/inner_nodes/output_node) and v1 (nodes/inputs/outputs)
    if (typeof jsonData !== "object" || jsonData === null) {
      output.error("Invalid workflow: not a JSON object");
      process.exit(1);
    }

    const isV2 =
      "input_node" in jsonData &&
      "inner_nodes" in jsonData &&
      "output_node" in jsonData;
    const isV1 =
      "nodes" in jsonData &&
      "inputs" in jsonData &&
      "outputs" in jsonData;

    if (!isV2 && !isV1) {
      output.error(
        "Invalid workflow: missing required fields (input_node, inner_nodes, output_node, edges)"
      );
      process.exit(1);
    }

    // Full validation via Python
    const pythonPath = await ensurePython();
    const result = await validateWorkflow(pythonPath, file);

    if (result.valid) {
      // Also check node types against the cache
      const { invalid, available } = await validateNodeTypes(
        pythonPath,
        file
      );
      if (invalid.length > 0) {
        output.warn(
          `Unknown node type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`
        );
        if (available.length > 0) {
          console.log(
            chalk.dim(`  Available: ${available.join(", ")}`)
          );
        }
        console.log(
          chalk.dim(
            "  Run 'ace workflow list-nodes' for all available types"
          )
        );
        process.exit(1);
      }

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

      // Prompt for node parameter customization (v2: inner_nodes)
      const nodes = (workflow.inner_nodes || workflow.nodes || []) as Array<{
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
      const inputNode = workflow.input_node as
        | { params?: { fields?: Record<string, unknown> } }
        | undefined;
      const inputNames = Object.keys(inputNode?.params?.fields ?? {});
      const inputArgs = inputNames
        .map((name) => `${name}='...'`)
        .join(" --input ");

      console.log(
        chalk.dim(`\nRun: ace run ${outputPath} --input ${inputArgs}`)
      );
    } finally {
      rl.close();
    }
  });
