import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { workflowCommand } from "./commands/workflow.js";

const program = new Command();

program
  .name("ace")
  .description("AceTeam CLI - Run AI workflows locally")
  .version("0.1.0");

program.addCommand(initCommand);
program.addCommand(workflowCommand);

program.parse();
