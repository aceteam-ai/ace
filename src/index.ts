import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { workflowCommand } from "./commands/workflow.js";
import { fabricCommand } from "./commands/fabric.js";
import { runCommand } from "./commands/run.js";

const program = new Command();

program
  .name("ace")
  .description("AceTeam CLI - Run AI workflows locally")
  .version("0.2.0");

program.addCommand(initCommand);
program.addCommand(runCommand);
program.addCommand(workflowCommand);
program.addCommand(fabricCommand);

program.parse();
