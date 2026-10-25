import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { addCompletionCommands, completionCandidates } from "../../src/commands/completion.js";

function sampleProgram(): Command {
  const root = new Command("ace").option("--json");
  const mcp = new Command("mcp").option("--schema <tool>").option("--quiet");
  root.addCommand(mcp);
  root.addCommand(new Command("org").addCommand(new Command("list")));
  addCompletionCommands(root);
  return root;
}

describe("shell completion", () => {
  async function scriptFor(shell: string): Promise<string> {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await sampleProgram().parseAsync(["completion", shell], { from: "user" });
      return String(output.mock.calls[0]?.[0]);
    } finally {
      output.mockRestore();
    }
  }

  function withFakeAce(run: (directory: string, env: NodeJS.ProcessEnv) => void): void {
    const directory = mkdtempSync(join(tmpdir(), "ace-completion-"));
    const executable = join(directory, "ace");
    writeFileSync(executable, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$ACE_TEST_ARGS"\nprintf "list\\n"\n');
    chmodSync(executable, 0o755);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, ACE_TEST_ARGS: join(directory, "args") };
    try {
      run(directory, env);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("suggests installed commands and nested flags while hiding its helper", () => {
    const root = sampleProgram();
    expect(completionCandidates(root, ["m"])).toEqual(["mcp"]);
    expect(completionCandidates(root, ["org", "l"])).toEqual(["list"]);
    expect(completionCandidates(root, ["mcp", "--s"])).toEqual(["--schema"]);
    expect(completionCandidates(root, ["__"])).toEqual([]);
    expect(completionCandidates(root, ["mcp", "--schema", "for"])).toEqual([]);
  });

  it("prints a Bash helper that delegates to the installed CLI", async () => {
    const root = sampleProgram();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await root.parseAsync(["completion", "bash"], { from: "user" });
      expect(output.mock.calls[0]?.[0]).toContain("command ace __complete");
      expect(output.mock.calls[0]?.[0]).toContain("complete -o default -F __ace_cli_complete ace");
    } finally {
      output.mockRestore();
    }
  });

  it("passes the current Bash word exactly once and allows path fallback", async () => {
    const script = await scriptFor("bash");
    withFakeAce((directory, env) => {
      const output = execFileSync("bash", ["-c", `${script}\nCOMP_WORDS=(ace org li)\nCOMP_CWORD=2\n__ace_cli_complete\nprintf '%s\\n' "\${COMPREPLY[@]}"\ncomplete -p ace`], { env, encoding: "utf8" });
      expect(output).toContain("list");
      expect(output).toContain("complete -o default -F __ace_cli_complete ace");
      expect(readFileSync(join(directory, "args"), "utf8").trim().split("\n")).toEqual([
        "__complete", "--", "org", "li",
      ]);
    });
  });

  it.skipIf(spawnSync("fish", ["--version"]).status !== 0)(
    "passes the cursor word to the helper from Fish completion",
    async () => {
      const script = await scriptFor("fish");
      withFakeAce((directory, env) => {
        const source = join(directory, "ace.fish");
        writeFileSync(source, script);
        const output = execFileSync("fish", ["-c", `source ${source}; complete -C 'ace org li'`], { env, encoding: "utf8" });
        expect(output).toContain("list");
        expect(readFileSync(join(directory, "args"), "utf8").trim().split("\n")).toEqual([
          "__complete", "--", "org", "li",
        ]);
      });
    }
  );

  it("limits Zsh arguments to the cursor and falls back to files", async () => {
    const script = await scriptFor("zsh");
    expect(script).toContain("words[2,CURRENT]");
    expect(script).toContain("_files");
  });
});
