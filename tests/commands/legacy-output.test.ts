import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { beginLegacyOutput, finishLegacyOutput } from "../../src/utils/legacy-output.js";

afterEach(() => {
  finishLegacyOutput();
  process.exitCode = 0;
  vi.restoreAllMocks();
});

function legacyCommand(json: boolean, quiet = false): Command {
  const root = new Command("ace");
  const command = root.command("workflow");
  command.setOptionValue("json", json);
  command.setOptionValue("quiet", quiet);
  return command;
}

it("returns one JSON result for an existing command's human output", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    beginLegacyOutput(legacyCommand(true));
    process.stdout.write("Workflow list:\n");
    process.stdout.write("  hello\n");
    expect(finishLegacyOutput()).toBe(true);
  } finally {
    process.stdout.write = original;
  }
  expect(JSON.parse(writes.join(""))).toEqual({ output: "Workflow list:\n  hello" });
});

it("suppresses successful output in quiet mode", () => {
  const writes: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    beginLegacyOutput(legacyCommand(false, true));
    process.stdout.write("hidden\n");
    expect(finishLegacyOutput()).toBe(true);
  } finally {
    process.stdout.write = original;
  }
  expect(writes).toEqual([]);
});

it("turns a legacy process exit into a stable JSON error", () => {
  const errors: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { errors.push(chunk); return true; }) as typeof process.stderr.write;
  try {
    beginLegacyOutput(legacyCommand(true));
    process.stderr.write("Invalid workflow\n");
    let thrown: unknown;
    try {
      process.exit(2);
    } catch (error) {
      thrown = error;
    }
    expect(finishLegacyOutput(thrown)).toBe(true);
  } finally {
    finishLegacyOutput();
    process.stderr.write = original;
  }
  expect(process.exitCode).toBe(2);
  expect(JSON.parse(errors.join(""))).toEqual({ error: { code: 2, message: "Invalid workflow" } });
});
