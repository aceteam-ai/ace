import { Command } from "commander";
import { hooksCommand } from "./commands/hooks.js";

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

  // Hook installation does not need the interactive prompt runtime.
  if (process.argv[2] !== "hooks") {
    const [{ initCommand }, { runCommand }, { workflowCommand }, { fabricCommand }, { loginCommand }] = await Promise.all([
      import("./commands/init.js"), import("./commands/run.js"), import("./commands/workflow.js"), import("./commands/fabric.js"), import("./commands/login.js"),
    ]);
    program.addCommand(initCommand);
    program.addCommand(runCommand);
    program.addCommand(workflowCommand);
    program.addCommand(fabricCommand);
    program.addCommand(loginCommand);
  }
  program.addCommand(hooksCommand);

  await program.parseAsync();
}
