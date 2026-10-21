import { Command, type Option } from "commander";
import { CliError } from "../utils/control-plane.js";
import { outputFlags, printValue, runCli } from "../utils/cli-output.js";

type Shell = "bash" | "zsh" | "fish";

const scripts: Record<Shell, string> = {
  bash: `# Add to ~/.bashrc: eval "$(ace completion bash)"
__ace_cli_complete() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local matches
  matches=$(command ace __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" "$current") || return
  COMPREPLY=( $(compgen -W "$matches" -- "$current") )
}
complete -F __ace_cli_complete ace`,
  zsh: `# Add to ~/.zshrc: eval "$(ace completion zsh)"
__ace_cli_complete() {
  local -a args matches
  args=("\${words[@]}")
  shift args
  matches=("\${(@f)$(command ace __complete -- "\${args[@]}")}")
  compadd -- "\${matches[@]}"
}
compdef __ace_cli_complete ace`,
  fish: `# Save to ~/.config/fish/completions/ace.fish: ace completion fish > ~/.config/fish/completions/ace.fish
function __ace_cli_complete
  set -l tokens (commandline -opc)
  if test (count $tokens) -gt 0
    set -e tokens[1]
  end
  command ace __complete -- $tokens (commandline -ct)
end
complete -c ace -a '(__ace_cli_complete)'`,
};

function optionName(option: Option, word: string): boolean {
  return word === option.long || word === option.short;
}

export function completionCandidates(root: Command, words: string[]): string[] {
  const current = words.at(-1) || "";
  let command = root;
  let expectValue = false;
  for (const word of words.slice(0, -1)) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (word.startsWith("-")) {
      const name = word.split("=", 1)[0];
      const option = command.options.find((entry) => optionName(entry, name));
      expectValue = Boolean(option?.required && !word.includes("="));
      continue;
    }
    const child = command.commands.find((entry) => entry.name() === word);
    if (child) command = child;
  }
  if (expectValue) return [];
  const commands = current.startsWith("-")
    ? []
    : command.commands.filter((child) => !child.name().startsWith("__")).map((child) => child.name());
  const options = command.options.flatMap((option) => [option.short, option.long].filter((name): name is string => Boolean(name)));
  options.push("-h", "--help");
  return [...new Set([...commands, ...options])].filter((candidate) => candidate.startsWith(current)).sort();
}

export function addCompletionCommands(program: Command): void {
  const completion = new Command("completion")
    .description("Print a shell completion script")
    .argument("<shell>", "bash, zsh, or fish");
  completion.action(async (shell: string) => {
    const flags = outputFlags(completion);
    await runCli(async () => {
      if (!(shell in scripts)) throw new CliError(2, "Choose bash, zsh, or fish.");
      const script = scripts[shell as Shell];
      printValue(script, flags);
    }, flags);
  });
  program.addCommand(completion);

  const complete = new Command("__complete")
    .description("Internal shell completion helper")
    .argument("[words...]")
    .allowUnknownOption();
  complete.action((words: string[]) => {
    process.stdout.write(completionCandidates(program, words).join("\n"));
  });
  program.addCommand(complete, { hidden: true });
}
