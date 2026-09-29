import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hooksPath, installHooks, hooksStatus, livenessHooks, mergeHooks } from "../../src/commands/hooks.js";

const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "ace-hooks-test-")); roots.push(path); return path; }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("liveness hook installation", () => {
  it.each(["claude-code", "codex"] as const)("installs %s into a temporary home idempotently without credentials", async harness => {
    const home = await root();
    const first = await installHooks(harness, "user", undefined, home, home);
    expect(first.some(line => line.includes("UserPromptSubmit"))).toBe(true);
    const path = hooksPath(harness, "user", home, home);
    const bytes = await readFile(path, "utf8");
    const config = JSON.parse(bytes);
    expect(config.hooks.UserPromptSubmit[0].hooks[0].input.presence_interval_s).toBe(300);
    expect(config.hooks.UserPromptSubmit[0].hooks[0].input.name).toBeUndefined();
    expect(config.hooks.PostToolUse).toEqual([{ hooks: [{ type: "mcp_tool", server: "aceteam", tool: "session_heartbeat", input: { state: "busy" }, timeout: harness === "codex" ? 2 : 1.5 }] }]);
    expect(config.hooks.Stop[0].hooks[0].input).toMatchObject({ drain: true, format: "hook", idle_on_empty: true });
    if (harness === "codex") expect(Number.isInteger(config.hooks.SessionEnd[0].hooks[0].timeout)).toBe(true);
    expect(bytes.toLowerCase()).not.toMatch(/authorization|bearer|api_key|api-key|token/);
    expect(await installHooks(harness, "user", undefined, home, home)).toEqual([`${path}: no changes`]);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps unrelated settings and handlers while upgrading old registration and drain hooks", () => {
    const other = { type: "command", command: "echo custom" };
    const existing = { permissions: { allow: ["Read"] }, hooks: {
      UserPromptSubmit: [{ hooks: [other, { type: "mcp_tool", server: "aceteam", tool: "session_register", input: {} }] }],
      Stop: [{ hooks: [{ type: "mcp_tool", server: "aceteam", tool: "session_inbox", input: { drain: true, format: "hook" }, statusMessage: "Checking inbox" }] }],
    } };
    const merged = mergeHooks(existing, livenessHooks("claude-code", "machine"));
    expect(merged.config.permissions).toEqual(existing.permissions);
    expect(merged.config.hooks.UserPromptSubmit[0].hooks[0]).toEqual(other);
    expect(merged.config.hooks.UserPromptSubmit[0].hooks[1].tool).toBe("session_heartbeat");
    expect(merged.config.hooks.Stop[0].hooks[0].statusMessage).toBe("Checking inbox");
    expect(mergeHooks(merged.config, livenessHooks("claude-code", "machine")).changes).toEqual([]);
    expect(existing.hooks.UserPromptSubmit[0].hooks[1].tool).toBe("session_register");
  });

  it("uses project scope and an explicit dedicated name only when requested", async () => {
    const home = await root(); const project = await root();
    await installHooks("claude-code", "project", "orchestrator", home, project);
    const config = JSON.parse(await readFile(hooksPath("claude-code", "project", home, project), "utf8"));
    expect(config.hooks.UserPromptSubmit[0].hooks[0].input.name).toBe("orchestrator");
    await expect(readFile(hooksPath("claude-code", "user", home, project))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("upgrades a Codex install missing completion presence without replacing unrelated hooks", async () => {
    const home = await root();
    const path = hooksPath("codex", "user", home, home);
    const previous = livenessHooks("codex", "machine");
    delete previous.hooks.PostToolUse;
    const observer = { type: "command", command: "echo custom" };
    previous.hooks.PostToolUse = [{ matcher: "Bash", hooks: [observer] }];
    await mkdir(join(home, ".codex"));
    await writeFile(path, JSON.stringify(previous));
    expect((await installHooks("codex", "user", undefined, home, home)).some(line => line.endsWith("add PostToolUse session_heartbeat"))).toBe(true);
    const installed = JSON.parse(await readFile(path, "utf8"));
    expect(installed.hooks.PostToolUse).toContainEqual({ matcher: "Bash", hooks: [observer] });
    expect(installed.hooks.PostToolUse.filter((group: { matcher?: string }) => !group.matcher)).toEqual(livenessHooks("codex").hooks.PostToolUse);
    expect(await installHooks("codex", "user", undefined, home, home)).toEqual([`${path}: no changes`]);
  });

  it("refuses malformed config without overwriting it", async () => {
    const home = await root(); await mkdir(join(home, ".codex"));
    const path = hooksPath("codex", "user", home, home);
    for (const invalid of ["not json", '{"hooks":{"Stop":null}}', '{"hooks":[]}']) {
      await writeFile(path, invalid);
      await expect(installHooks("codex", "user", undefined, home, home)).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(invalid);
    }
  });

  it("reports MCP and hook status without printing credentials", async () => {
    const home = await root();
    await installHooks("codex", "user", undefined, home, home);
    await writeFile(join(home, ".codex", "config.toml"), '[mcp_servers.aceteam]\nurl = "https://example.test/mcp"\nbearer_token_env_var = "PRIVATE_VALUE"\n');
    const output = (await hooksStatus("codex", "user", home, home)).join("\n");
    expect(output).toContain("aceteam MCP server: configured");
    expect(output).toContain("Stop: session_inbox");
    expect(output).toContain("PostToolUse: session_heartbeat");
    expect(output).not.toContain("PRIVATE_VALUE");
  });

  it("never installs a permission decision hook or the Claude UUID as a transport binding", () => {
    const config = livenessHooks("claude-code");
    expect(config.hooks.PermissionRequest).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("harness_session_id");
    expect(config.hooks.Notification.map(group => group.matcher)).toEqual(["permission_prompt", "elicitation_dialog", "idle_prompt"]);
  });
});

describe("installed Codex parser", () => {
  it.skipIf(!(process.env.PATH ?? "").split(":").some(path => existsSync(join(path, "codex"))))("accepts completion hooks in an isolated credential-free config", async () => {
    const home = await root();
    await installHooks("codex", "user", undefined, home, home);
    await writeFile(join(home, ".codex", "config.toml"), 'model = "parser-only"\nmodel_provider = "local_parser"\n[model_providers.local_parser]\nname = "Parser only"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n');
    const result = spawnSync("codex", ["exec", "--skip-git-repo-check", "--json", "Parser check only"], {
      cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex") }, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.stdout, result.stderr).toContain('"type":"thread.started"');
    expect(result.stderr).not.toMatch(/Error loading hooks|invalid type|PostToolUse.*not supported/);
    expect(result.stdout, result.stderr).toContain('"type":"turn.started"');
  }, 10000);
});
