import { Command, CommanderError } from "commander";
import { initCommand } from "./commands/init.js";
import { workflowCommand } from "./commands/workflow.js";
import { fabricCommand } from "./commands/fabric.js";
import { runCommand } from "./commands/run.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { mcpCommand, orgCommand, whoamiCommand } from "./commands/control-plane.js";
import { addCompletionCommands } from "./commands/completion.js";
import { agentCommand } from "./commands/agent.js";
import { beginLegacyOutput, finishLegacyOutput } from "./utils/legacy-output.js";

function addOutputOptions(command: Command): void {
  const options = command.options.map((option) => option.long);
  if (!options.includes("--json")) command.option("--json", "Output JSON");
  if (!options.includes("--quiet")) command.option("--quiet", "Suppress successful output");
  for (const child of command.commands) addOutputOptions(child);
}

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
  program.addCommand(agentCommand);
  addCompletionCommands(program);

  addOutputOptions(program);
  program.exitOverride();
  program.configureOutput({
    writeOut: (value) => process.stdout.write(value),
    writeErr: (value) => {
      if (!process.argv.includes("--json")) process.stderr.write(value);
    },
  });
  program.hook("preAction", (_root, action) => beginLegacyOutput(action));
  program.hook("postAction", () => {
    finishLegacyOutput();
  });
  try {
    await program.parseAsync();
  } catch (error) {
    if (!finishLegacyOutput(error)) {
      if (error instanceof CommanderError) {
        if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
          process.exitCode = 0;
        } else {
          process.exitCode = 2;
          if (process.argv.includes("--json")) {
            console.error(JSON.stringify({ error: { code: 2, message: error.message } }));
          }
        }
      } else {
        throw error;
      }
    }
  }
}
