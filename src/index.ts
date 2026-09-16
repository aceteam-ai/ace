import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { fabricCommand } from "./commands/fabric.js";
import { initCommand } from "./commands/init.js";
import { loginCommand } from "./commands/login.js";
import { runCommand } from "./commands/run.js";
import { workflowCommand } from "./commands/workflow.js";
import { templatesCommand } from "./commands/templates.js";
import { startInteractive } from "./commands/interactive.js";

export function createProgram(): Command {
  const program = new Command();
  program.name("ace").description("AceTeam CLI - Run AI workflows locally").version("0.3.0");
  program.addCommand(initCommand);
  program.addCommand(runCommand);
  program.addCommand(workflowCommand);
  program.addCommand(templatesCommand);
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

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entry === import.meta.url) await main();
