import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { hooksPath, hooksStatus, installHooks, livenessHooks, mergeHooks } from "../../src/commands/hooks.js";

const temporaryRoots: string[] = [];
async function temporaryHome() {
  const path = await mkdtemp(join(tmpdir(), "ace-blocked-hooks-"));
  temporaryRoots.push(path);
  return path;
}
afterEach(async () => {
  for (const path of temporaryRoots.splice(0)) await rm(path, { recursive: true, force: true });
});

const questionInput = {
  state: "blocked", blocked_on: "human:input", reason: "Waiting for an operator answer",
};

describe("S2 blocked-state installer companion", () => {
  it("observes AskUserQuestion only and preserves S1 completion and notification mappings", () => {
    const config = livenessHooks("claude-code", "fixture-machine");
    expect(config.hooks.PreToolUse).toEqual([{
      matcher: "AskUserQuestion", hooks: [{ type: "mcp_tool", server: "aceteam", tool: "session_heartbeat", input: questionInput, timeout: 1.5 }],
    }]);
    expect(config.hooks.PostToolUse).toEqual([{
      hooks: [{ type: "mcp_tool", server: "aceteam", tool: "session_heartbeat", input: { state: "busy" }, timeout: 1.5 }],
    }]);
    expect(config.hooks.Notification.map(group => group.matcher)).toEqual(["permission_prompt", "elicitation_dialog", "idle_prompt"]);
    expect(config.hooks.Notification[1].hooks[0].input).toEqual({ state: "blocked", blocked_on: "human:input", reason: "Waiting for operator input" });
    expect(config.hooks.Stop[0].hooks[0].input).toEqual({ drain: true, format: "hook", idle_on_empty: true });
    expect(config.hooks.PermissionRequest).toBeUndefined();
    expect(config.hooks.Elicitation).toBeUndefined();
    expect(config.hooks.ElicitationResult).toBeUndefined();
    expect(JSON.stringify(config).toLowerCase()).not.toMatch(/permissiondecision|updatedinput|hookspecificoutput|harness_session_id|authorization|bearer|api_key|api-key|token/);
  });

  it("keeps Codex declaration-only and its S1 integer timeouts unchanged", () => {
    const config = livenessHooks("codex", "fixture-machine");
    expect(Object.keys(config.hooks).sort()).toEqual(["PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(config.hooks.PostToolUse).toEqual([{
      hooks: [{ type: "mcp_tool", server: "aceteam", tool: "session_heartbeat", input: { state: "busy" }, timeout: 2 }],
    }]);
    expect(config.hooks.SessionEnd[0].hooks[0].timeout).toBe(2);
    expect(config.hooks.UserPromptSubmit[0].hooks[0].input).toMatchObject({ state: "busy", harness_session_id: "${session_id}" });
    expect(config.hooks.Stop[0].hooks[0].input).toMatchObject({ idle_on_empty: true, harness_session_id: "${session_id}" });
  });

  it("upgrades an S1 installation with only the new observer and is byte-idempotent", async () => {
    const home = await temporaryHome();
    const path = hooksPath("claude-code", "user", home, home);
    await mkdir(join(home, ".claude"));
    const s1 = livenessHooks("claude-code", hostname());
    delete s1.hooks.PreToolUse;
    await writeFile(path, JSON.stringify(s1), { mode: 0o640 });
    const before = structuredClone(s1.hooks);
    const changes = await installHooks("claude-code", "user", undefined, home, home);
    expect(changes.slice(1)).toEqual(["  + add PreToolUse (AskUserQuestion) session_heartbeat"]);
    const installedBytes = await readFile(path, "utf8");
    const installed = JSON.parse(installedBytes);
    expect(installed.hooks.PreToolUse[0].hooks[0].input).toEqual(questionInput);
    delete installed.hooks.PreToolUse;
    expect(installed.hooks).toEqual(before);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await installHooks("claude-code", "user", undefined, home, home)).toEqual([`${path}: no changes`]);
    expect(await readFile(path, "utf8")).toBe(installedBytes);
    expect(await readdir(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  it("preserves neighboring custom observers while upgrading and deduplicating its own", () => {
    const custom = { type: "command", command: "custom-question-observer" };
    const otherServer = { type: "mcp_tool", server: "other", tool: "session_heartbeat", input: {} };
    const owned = { type: "mcp_tool", server: "aceteam", tool: "session_heartbeat", input: { state: "idle" }, timeout: 9, statusMessage: "Observing question" };
    const existing = { permissions: { allow: ["Read"] }, hooks: {
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [custom, owned, otherServer, { ...owned }] }, { matcher: "Bash", hooks: [custom] }],
    } };
    const before = structuredClone(existing);
    const merged = mergeHooks(existing, livenessHooks("claude-code", "fixture-machine"));
    expect(existing).toEqual(before);
    expect(merged.config.permissions).toEqual(existing.permissions);
    const question = merged.config.hooks.PreToolUse[0];
    expect(question.hooks.filter(hook => hook.server === "aceteam")).toHaveLength(1);
    expect(question.hooks).toContainEqual(custom);
    expect(question.hooks).toContainEqual(otherServer);
    expect(question.hooks[1]).toMatchObject({ input: questionInput, timeout: 1.5, statusMessage: "Observing question" });
    expect(merged.config.hooks.PreToolUse[1]).toEqual(existing.hooks.PreToolUse[1]);
    expect(mergeHooks(merged.config, livenessHooks("claude-code", "fixture-machine")).changes).toEqual([]);
  });

  it("reports the question observer and the existing completion clear in status without secrets", async () => {
    const home = await temporaryHome();
    await installHooks("claude-code", "user", undefined, home, home);
    await writeFile(join(home, ".claude.json"), JSON.stringify({ mcpServers: { aceteam: { url: "https://example.test/mcp", headers: { Authorization: "PRIVATE_STATUS_VALUE" } } } }));
    const lines = await hooksStatus("claude-code", "user", home, home);
    expect(lines).toContain("PreToolUse (AskUserQuestion): session_heartbeat");
    expect(lines).toContain("PostToolUse: session_heartbeat");
    expect(lines).toContain("Notification (elicitation_dialog): session_heartbeat");
    expect(lines).toContain("aceteam MCP server: configured");
    expect(lines.join("\n")).not.toContain("PRIVATE_STATUS_VALUE");
  });

  it("confines project installation and its observer to the temporary project", async () => {
    const home = await temporaryHome();
    const project = await temporaryHome();
    await installHooks("claude-code", "project", "dedicated", home, project);
    const config = JSON.parse(await readFile(hooksPath("claude-code", "project", home, project), "utf8"));
    expect(config.hooks.PreToolUse[0].hooks[0].input).toEqual(questionInput);
    expect(config.hooks.PreToolUse[0].hooks[0].input.name).toBeUndefined();
    expect(config.hooks.UserPromptSubmit[0].hooks[0].input.name).toBe("dedicated");
    expect(await readdir(home)).toEqual([]);
  });

  it.each([
    '{"hooks":{"PreToolUse":null}}',
    '{"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion","hooks":null}]}}',
    '{"hooks":{"PreToolUse":[{"matcher":"AskUserQuestion","hooks":["invalid"]}]}}',
  ])("rejects malformed observer configuration without changing bytes: %s", async invalid => {
    const home = await temporaryHome();
    await mkdir(join(home, ".claude"));
    const path = hooksPath("claude-code", "user", home, home);
    await writeFile(path, invalid);
    await expect(installHooks("claude-code", "user", undefined, home, home)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(invalid);
    expect(await readdir(join(home, ".claude"))).toEqual(["settings.json"]);
  });
});
