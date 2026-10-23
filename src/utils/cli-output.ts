import type { Command } from "commander";
import { CliError } from "./control-plane.js";

export interface OutputFlags {
  json: boolean;
  quiet: boolean;
}

export function outputFlags(command: Command, localJson = false): OutputFlags {
  let json = localJson;
  let quiet = false;
  for (let current: Command | null = command; current; current = current.parent) {
    const options = current.opts() as { json?: unknown; quiet?: boolean };
    json ||= options.json !== undefined && options.json !== false;
    quiet ||= Boolean(options.quiet);
  }
  return { json, quiet };
}

export function printValue(
  value: unknown,
  flags: OutputFlags,
  human?: (value: unknown) => string,
): void {
  if (flags.quiet) return;
  if (flags.json) {
    console.log(JSON.stringify(value));
  } else {
    console.log(human ? human(value) : typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}

export async function runCli(
  action: () => Promise<void>,
  flags: OutputFlags,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError(4, "Command failed. Retry or check the control-plane connection.");
    process.exitCode = failure.exitCode;
    if (flags.json) {
      console.error(JSON.stringify({ error: { code: failure.exitCode, message: failure.message } }));
    } else {
      console.error("Error: " + failure.message);
    }
  }
}
