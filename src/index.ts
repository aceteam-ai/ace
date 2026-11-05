import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import { beginLegacyOutput, finishLegacyOutput } from "./utils/legacy-output.js";
import { CliError } from "./utils/control-plane.js";
import { hooksCommand } from "./commands/hooks.js";

function addOutputOptions(command: Command): void {
  const options = command.options.map((option) => option.long);
  if (!options.includes("--json")) command.option("--json", "Output JSON");
  if (!options.includes("--quiet")) command.option("--quiet", "Suppress successful output");
  for (const child of command.commands) addOutputOptions(child);
}

function configureErrorHandling(command: Command): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (value) => process.stdout.write(value),
    writeErr: (value) => {
      if (!process.argv.includes("--json")) process.stderr.write(value);
    },
  });
  for (const child of command.commands) configureErrorHandling(child);
}

export async function createProgram(argv = process.argv): Promise<Command> {
  const program = new Command();

  program
    .name("ace")
    .description("AceTeam CLI for the control plane and local workflows")
    .version("0.3.0")
    .enablePositionalOptions()
    .option("--json", "Output JSON")
    .option("--quiet", "Suppress successful output");

  // Hook installation must remain usable without loading the interactive
  // command runtime, which requires a newer Node release.
  if (argv[2] !== "hooks") {
    const [init, run, workflow, fabric, login, controlPlane, completion, agent] = await Promise.all([
      import("./commands/init.js"),
      import("./commands/run.js"),
      import("./commands/workflow.js"),
      import("./commands/fabric.js"),
      import("./commands/login.js"),
      import("./commands/control-plane.js"),
      import("./commands/completion.js"),
      import("./commands/agent.js"),
    ]);
    program.addCommand(init.initCommand);
    program.addCommand(run.runCommand);
    program.addCommand(workflow.workflowCommand);
    program.addCommand(fabric.fabricCommand);
    program.addCommand(login.loginCommand);
    program.addCommand(login.logoutCommand);
    program.addCommand(controlPlane.whoamiCommand);
    program.addCommand(controlPlane.orgCommand);
    program.addCommand(controlPlane.mcpCommand);
    program.addCommand(agent.agentCommand);
    completion.addCompletionCommands(program);
  }
  program.addCommand(hooksCommand);

  addOutputOptions(program);
  configureErrorHandling(program);
  program.hook("preAction", (_root, action) => beginLegacyOutput(action));
  program.hook("postAction", () => {
    finishLegacyOutput();
  });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  if (argv.length === 2) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { startInteractive } = await import("./commands/interactive.js");
      await startInteractive();
    } else {
      (await createProgram(argv)).outputHelp();
    }
    return;
  }
  const program = await createProgram(argv);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (!finishLegacyOutput(error)) {
      if (error instanceof CliError) {
        process.exitCode = error.exitCode;
        if (process.argv.includes("--json")) {
          console.error(JSON.stringify({ error: { code: error.exitCode, message: error.message } }));
        } else {
          console.error("Error: " + error.message);
        }
      } else if (error instanceof CommanderError) {
        if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
          process.exitCode = 0;
        } else if (error.code === "ace.hooksConfigError") {
          process.exitCode = 1;
          if (process.argv.includes("--json")) {
            console.error(JSON.stringify({ error: { code: 1, message: error.message } }));
          }
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

export function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  try {
    return pathToFileURL(realpathSync(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) await main();
