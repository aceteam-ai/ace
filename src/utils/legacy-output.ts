import type { Command } from "commander";
import { outputFlags, type OutputFlags } from "./cli-output.js";
import { CliError } from "./control-plane.js";

class LegacyExit extends Error {
  constructor(readonly status: number) {
    super("Legacy command exited.");
  }
}

interface Capture {
  flags: OutputFlags;
  stdout: string[];
  stderr: string[];
  originalOut: typeof process.stdout.write;
  originalErr: typeof process.stderr.write;
  originalExit: typeof process.exit;
}

let active: Capture | undefined;

function topLevelName(command: Command): string {
  let current = command;
  while (current.parent && current.parent.parent) current = current.parent;
  return current.name();
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

function textChunk(chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
}

export function beginLegacyOutput(command: Command): void {
  if (["login", "logout", "whoami", "org", "mcp", "agent", "completion", "__complete"].includes(topLevelName(command))) return;
  const flags = outputFlags(command);
  if ((!flags.json && !flags.quiet) || active) return;
  if (["init", "fabric login", "workflow create"].includes(commandPath(command))) {
    throw new CliError(2, "This command prompts for input. Run it without JSON or quiet output.");
  }
  active = {
    flags,
    stdout: [],
    stderr: [],
    originalOut: process.stdout.write,
    originalErr: process.stderr.write,
    originalExit: process.exit,
  };
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
    active?.stdout.push(textChunk(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
    active?.stderr.push(textChunk(chunk));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") done();
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((status?: number) => {
    throw new LegacyExit(status ?? Number(process.exitCode || 0));
  }) as typeof process.exit;
}

export function finishLegacyOutput(error?: unknown): boolean {
  const capture = active;
  if (!capture) return false;
  active = undefined;
  process.stdout.write = capture.originalOut;
  process.stderr.write = capture.originalErr;
  process.exit = capture.originalExit;

  const stdout = capture.stdout.join("").trim();
  const stderr = capture.stderr.join("").trim();
  const status = error instanceof LegacyExit ? error.status : error ? 4 : Number(process.exitCode || 0);
  if (status) {
    process.exitCode = status;
    const message = stderr || (error instanceof Error ? error.message : stdout || "Command failed.");
    if (capture.flags.json) {
      process.stderr.write(JSON.stringify({ error: { code: status, message } }) + "\n");
    } else {
      process.stderr.write(message + "\n");
    }
    return true;
  }
  if (!capture.flags.quiet) {
    let value: unknown = { output: stdout };
    if (stdout) {
      try {
        value = JSON.parse(stdout) as unknown;
      } catch {
        // Preserve human output as one JSON string field.
      }
    }
    process.stdout.write(JSON.stringify(value) + "\n");
  }
  return true;
}
