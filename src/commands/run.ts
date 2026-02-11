import { Command } from "commander";
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
import * as output from "../utils/output.js";

export const runCommand = new Command("run")
  .description("Run a pattern on text input (pipe-friendly)")
  .argument("[pattern]", "Pattern name to run")
  .argument("[text]", "Inline text input")
  .option("-l, --list", "List available patterns")
  .option("--info <pattern>", "Show pattern details")
  .option("-m, --model <model>", "Override the LLM model")
  .option("-j, --json", "Output as JSON")
  .option("-v, --verbose", "Show debug output")
  .option("-f, --file <path>", "Read input from a file")
  .option("--input-dir <path>", "Process all files in a directory")
  .option("-o, --output <path>", "Write output to a file")
  .option("--output-dir <path>", "Write batch outputs to a directory")
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

        console.log(chalk.dim(`\nUser patterns: ${getUserPatternsDir()}`));
        return;
      }

      // ── Pattern info ───────────────────────────────────
      if (options.info) {
        const pattern = loadPattern(options.info);
        if (!pattern) {
          output.error(`Pattern not found: ${options.info}`);
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

      // ── Validate pattern name ──────────────────────────
      if (!patternName) {
        output.error("Pattern name required. Use --list to see available patterns.");
        console.log(chalk.dim("Usage: ace run <pattern> [text]"));
        console.log(chalk.dim("       echo \"text\" | ace run <pattern>"));
        process.exit(1);
      }

      const pattern = loadPattern(patternName);
      if (!pattern) {
        output.error(`Pattern not found: ${patternName}`);
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
        console.log(chalk.dim("Usage: ace run <pattern> \"text to process\""));
        console.log(chalk.dim("       ace run <pattern> --file input.txt"));
        console.log(chalk.dim("       echo \"text\" | ace run <pattern>"));
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
