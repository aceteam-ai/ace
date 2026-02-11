import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import ora from "ora";
import chalk from "chalk";
import { BUILTIN_PATTERNS, type PatternDef } from "../patterns/index.js";
import { loadConfig } from "./config.js";
import { runWorkflow, type RunResult } from "./python.js";
import { classifyPythonError } from "./errors.js";
import * as output from "./output.js";

const USER_PATTERNS_DIR = join(homedir(), ".ace", "patterns");
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json"]);

// ── Pattern Loading ────────────────────────────────────────

export function getUserPatternsDir(): string {
  return USER_PATTERNS_DIR;
}

const PATTERN_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function loadUserPattern(name: string): PatternDef | undefined {
  if (!PATTERN_NAME_REGEX.test(name)) {
    return undefined;
  }

  const patternDir = join(USER_PATTERNS_DIR, name);
  const systemFile = join(patternDir, "system.md");

  if (!existsSync(systemFile)) {
    return undefined;
  }

  const systemPrompt = readFileSync(systemFile, "utf-8").trim();
  return {
    id: name,
    name: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: `User pattern: ${name}`,
    category: "user",
    systemPrompt,
  };
}

function listUserPatterns(): PatternDef[] {
  if (!existsSync(USER_PATTERNS_DIR)) {
    return [];
  }

  const entries = readdirSync(USER_PATTERNS_DIR, { withFileTypes: true });
  const patterns: PatternDef[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pattern = loadUserPattern(entry.name);
      if (pattern) {
        patterns.push(pattern);
      }
    }
  }

  return patterns;
}

export function listPatterns(): PatternDef[] {
  const userPatterns = listUserPatterns();
  const userIds = new Set(userPatterns.map((p) => p.id));

  // User patterns override built-ins with the same name
  const builtins = BUILTIN_PATTERNS.filter((p) => !userIds.has(p.id));
  return [...builtins, ...userPatterns];
}

export function loadPattern(name: string): PatternDef | undefined {
  // User patterns take priority over built-ins
  const userPattern = loadUserPattern(name);
  if (userPattern) {
    return userPattern;
  }

  return BUILTIN_PATTERNS.find((p) => p.id === name);
}

// ── Workflow Generation ────────────────────────────────────

export function patternToWorkflow(
  pattern: PatternDef,
  modelOverride?: string
): Record<string, unknown> {
  const config = loadConfig();
  const model = modelOverride || pattern.model || config.default_model || "gpt-4o-mini";
  const temperature = String(pattern.temperature ?? 0.7);

  return {
    name: pattern.name,
    description: pattern.description,
    nodes: [
      {
        id: "llm",
        type: "LLM",
        params: {
          model,
          system_prompt: pattern.systemPrompt,
          temperature,
          max_tokens: "4096",
        },
        position: { x: 400, y: 200 },
      },
    ],
    edges: [],
    input_edges: [
      {
        input_key: "prompt",
        target_id: "llm",
        target_key: "prompt",
      },
    ],
    output_edges: [
      {
        source_id: "llm",
        source_key: "response",
        output_key: "response",
      },
    ],
    inputs: [
      {
        name: "prompt",
        type: "LONG_TEXT",
        display_name: "Prompt",
        description: "The text to process",
      },
    ],
    outputs: [
      {
        name: "response",
        type: "LONG_TEXT",
        display_name: "Response",
        description: "The processed output",
      },
    ],
  };
}

// ── I/O Utilities ──────────────────────────────────────────

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
    process.stdin.on("error", reject);
  });
}

export function readInputFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file type: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`
    );
  }

  return readFileSync(filePath, "utf-8").trim();
}

export function scanInputDir(dirPath: string): string[] {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`);
  }

  const entries = readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter(
      (e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase())
    )
    .map((e) => join(dirPath, e.name))
    .sort();
}

export function writeOutput(text: string, filePath?: string): void {
  if (filePath) {
    writeFileSync(filePath, text + "\n", "utf-8");
  } else {
    process.stdout.write(text + "\n");
  }
}

// ── Execution ──────────────────────────────────────────────

export interface RunPatternOptions {
  model?: string;
  json?: boolean;
  verbose?: boolean;
}

export async function runPattern(
  pythonPath: string,
  pattern: PatternDef,
  inputText: string,
  options: RunPatternOptions = {}
): Promise<string> {
  const workflow = patternToWorkflow(pattern, options.model);
  const tempFile = join(tmpdir(), `ace-pattern-${pattern.id}-${Date.now()}.json`);

  try {
    writeFileSync(tempFile, JSON.stringify(workflow, null, 2), "utf-8");

    const result: RunResult = await runWorkflow(
      pythonPath,
      tempFile,
      { prompt: inputText },
      { verbose: options.verbose }
    );

    if (!result.success) {
      const rawError =
        result.error ||
        (result.errors ? JSON.stringify(result.errors) : "Unknown error");
      const classified = classifyPythonError(rawError);
      throw new Error(classified.message + (classified.suggestion ? `\n${classified.suggestion}` : ""));
    }

    const response = result.output?.response;
    if (typeof response !== "string") {
      throw new Error("Unexpected output format from workflow");
    }

    if (options.json) {
      return JSON.stringify({ pattern: pattern.id, response }, null, 2);
    }

    return response;
  } finally {
    // Clean up temp file (best effort)
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup failures
    }
  }
}

export interface BatchOptions extends RunPatternOptions {
  outputDir: string;
}

export async function runBatch(
  pythonPath: string,
  pattern: PatternDef,
  inputDir: string,
  options: BatchOptions
): Promise<void> {
  const files = scanInputDir(inputDir);
  if (files.length === 0) {
    output.warn(`No supported files found in ${inputDir}`);
    return;
  }

  // Ensure output directory exists
  if (!existsSync(options.outputDir)) {
    mkdirSync(options.outputDir, { recursive: true });
  }

  const spinner = ora(`Processing 0/${files.length}...`).start();
  let processed = 0;
  let failed = 0;

  for (const file of files) {
    const fileName = basename(file, extname(file));
    const outputFile = join(options.outputDir, `${fileName}.txt`);

    spinner.text = `Processing ${processed + 1}/${files.length}: ${basename(file)}...`;

    try {
      const content = readInputFile(file);
      const result = await runPattern(pythonPath, pattern, content, {
        model: options.model,
        verbose: options.verbose,
      });
      writeFileSync(outputFile, result + "\n", "utf-8");
      processed++;
    } catch (err) {
      failed++;
      spinner.warn(
        `Failed: ${basename(file)} — ${err instanceof Error ? err.message : String(err)}`
      );
      spinner.start(`Processing ${processed + failed + 1}/${files.length}...`);
    }
  }

  if (failed === 0) {
    spinner.succeed(
      `Processed ${processed} file${processed === 1 ? "" : "s"} ${chalk.dim(`→ ${options.outputDir}`)}`
    );
  } else {
    spinner.warn(
      `Processed ${processed}/${files.length} files (${failed} failed) ${chalk.dim(`→ ${options.outputDir}`)}`
    );
  }
}
