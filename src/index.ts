import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { workflowCommand } from "./commands/workflow.js";
import { fabricCommand } from "./commands/fabric.js";
import { runCommand } from "./commands/run.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { mcpCommand, orgCommand, whoamiCommand } from "./commands/control-plane.js";

// No args + TTY → interactive mode
if (process.argv.length === 2 && process.stdin.isTTY) {
  const { startInteractive } = await import("./commands/interactive.js");
  await startInteractive();
} else {
  const program = new Command();

  program
    .name("ace")
    .description("AceTeam CLI for the control plane and local workflows")
    .version("0.3.0")
    .enablePositionalOptions()
    .option("--json", "Output JSON")
    .option("--quiet", "Suppress successful output");

  program.addCommand(initCommand);
  program.addCommand(runCommand);
  program.addCommand(workflowCommand);
  program.addCommand(fabricCommand);
  program.addCommand(loginCommand);
  program.addCommand(logoutCommand);
  program.addCommand(whoamiCommand);
  program.addCommand(orgCommand);
  program.addCommand(mcpCommand);

  await program.parseAsync();
}
