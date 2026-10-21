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
      expect(output.mock.calls[0]?.[0]).toContain("complete -F __ace_cli_complete ace");
    } finally {
      output.mockRestore();
    }
  });
});
