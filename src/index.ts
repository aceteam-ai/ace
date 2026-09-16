import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { fabricCommand } from "./commands/fabric.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { runCommand } from "./commands/run.js";
import { workflowCommand } from "./commands/workflow.js";
import { startInteractive } from "./commands/interactive.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("ace").description("AceTeam CLI - Run AI workflows locally").version("0.3.0");
  program.addCommand(initCommand);
  program.addCommand(runCommand);
  program.addCommand(workflowCommand);
  program.addCommand(fabricCommand);
  program.addCommand(loginCommand);
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  if (argv.length === 2) {
    if (process.stdin.isTTY && process.stdout.isTTY) await startInteractive();
    else createProgram().outputHelp();
    return;
  }
  await createProgram().parseAsync(argv);
}

export function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try {
    return pathToFileURL(realpathSync(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) await main();
