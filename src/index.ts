import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { workflowCommand } from "./commands/workflow.js";
import { fabricCommand } from "./commands/fabric.js";
import { runCommand } from "./commands/run.js";
import { loginCommand } from "./commands/login.js";

// No args + TTY → interactive mode
if (process.argv.length === 2 && process.stdin.isTTY) {
  const { startInteractive } = await import("./commands/interactive.js");
  await startInteractive();
} else {
  const program = new Command();

  program
    .name("ace")
    .description("AceTeam CLI - Run AI workflows locally")
    .version("0.3.0");

  program.addCommand(initCommand);
  program.addCommand(runCommand);
  program.addCommand(workflowCommand);
  program.addCommand(fabricCommand);
  program.addCommand(loginCommand);

  program.parse();
}
