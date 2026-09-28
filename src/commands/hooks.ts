import { Command } from "commander";
import { readFile, mkdir, writeFile, rename, stat, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type Harness = "claude-code" | "codex";
type Scope = "user" | "project";
type JsonObject = Record<string, unknown>;
type Handler = JsonObject & { type: string; server: string; tool: string; input: JsonObject; timeout: number };
type Group = JsonObject & { matcher?: string; hooks: JsonObject[] };
type HookConfig = JsonObject & { hooks: Record<string, Group[]> };

export function livenessHooks(harness: Harness, machine = hostname(), name?: string): HookConfig {
  const registration: JsonObject = {
    harness, machine, cwd: "${cwd}", permission_mode: "${permission_mode}", presence_interval_s: 300,
    ...(harness === "codex" ? { harness_session_id: "${session_id}" } : {}),
    ...(name ? { name } : {}),
  };
  const handler = (tool: string, input: JsonObject, timeout = 1.5): Handler => ({ type: "mcp_tool", server: "aceteam", tool, input, timeout });
  const group = (hook: Handler, matcher?: string): Group => ({ ...(matcher ? { matcher } : {}), hooks: [hook] });
  const hooks: Record<string, Group[]> = {
    SessionStart: [group(handler("session_heartbeat", registration, 3))],
    UserPromptSubmit: [group(handler("session_heartbeat", { ...registration, state: "busy" }, 3))],
    Stop: [group(handler("session_inbox", { drain: true, format: "hook", idle_on_empty: true, ...(harness === "codex" ? { harness_session_id: "${session_id}" } : {}) }, 10))],
    SessionEnd: [group(handler("session_unregister", {}))],
  };
  if (harness === "claude-code") {
    hooks.PostToolUse = [group(handler("session_heartbeat", { state: "busy" }))];
    hooks.Notification = [
      group(handler("session_heartbeat", { state: "blocked", blocked_on: "human:permission", reason: "Waiting for operator permission" }), "permission_prompt"),
      group(handler("session_heartbeat", { state: "blocked", blocked_on: "human:input", reason: "Waiting for operator input" }), "elicitation_dialog"),
      group(handler("session_heartbeat", { state: "idle" }), "idle_prompt"),
    ];
  }
  return { hooks };
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfig(text: string): HookConfig {
  const config: unknown = JSON.parse(text);
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) throw new Error("Hook configuration must be a JSON object with an optional hooks object.");
  const hooks = (config.hooks ?? {}) as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !object(group) || !Array.isArray(group.hooks) || group.hooks.some(hook => !object(hook)))) {
      throw new Error(`Invalid hook groups for ${event}; the file was not changed.`);
    }
  }
  return { ...config, hooks: hooks as Record<string, Group[]> };
}

export function mergeHooks(existing: HookConfig, desired: HookConfig): { config: HookConfig; changes: string[] } {
  const config = structuredClone(existing);
  const changes: string[] = [];
  for (const [event, desiredGroups] of Object.entries(desired.hooks)) {
    const groups = config.hooks[event] ??= [];
    for (const desiredGroup of desiredGroups) {
      const wanted = desiredGroup.hooks[0];
      let installed = false;
      for (const group of groups) {
        if ((group.matcher ?? "") !== (desiredGroup.matcher ?? "")) continue;
        group.hooks = group.hooks.flatMap(hook => {
          const legacyRegister = (event === "SessionStart" || event === "UserPromptSubmit") && hook.tool === "session_register" && wanted.tool === "session_heartbeat";
          if (hook.type !== "mcp_tool" || hook.server !== "aceteam" || (hook.tool !== wanted.tool && !legacyRegister)) return [hook];
          if (installed) { changes.push(`remove duplicate ${event} ${String(wanted.tool)}`); return []; }
          installed = true;
          if (Object.entries(wanted).every(([key, value]) => isDeepStrictEqual(hook[key], value))) return [hook];
          changes.push(`update ${event}${desiredGroup.matcher ? ` (${desiredGroup.matcher})` : ""} ${String(wanted.tool)}`);
          return [{ ...hook, ...wanted }];
        });
      }
      if (!installed) {
        groups.push(structuredClone(desiredGroup));
        changes.push(`add ${event}${desiredGroup.matcher ? ` (${desiredGroup.matcher})` : ""} ${String(wanted.tool)}`);
      }
    }
  }
  return { config, changes };
}

export function hooksPath(harness: Harness, scope: Scope, home = homedir(), cwd = process.cwd()): string {
  return join(scope === "user" ? home : cwd, harness === "claude-code" ? ".claude" : ".codex", harness === "claude-code" ? "settings.json" : "hooks.json");
}

async function readConfig(path: string): Promise<{ config: HookConfig; text: string; mode: number }> {
  try {
    const text = await readFile(path, "utf8");
    return { config: parseConfig(text), text, mode: (await stat(path)).mode & 0o777 };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { hooks: {} }, text: "", mode: 0o600 };
    throw error;
  }
}

export async function installHooks(harness: Harness, scope: Scope, name?: string, home?: string, cwd?: string): Promise<string[]> {
  if (name && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("Name must be lowercase, start with a letter or digit, and contain at most 64 letters, digits, periods, underscores, or hyphens.");
  const path = hooksPath(harness, scope, home, cwd);
  const before = await readConfig(path);
  const { config, changes } = mergeHooks(before.config, livenessHooks(harness, hostname(), name));
  if (!changes.length) return [`${path}: no changes`];
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: before.mode });
    // Avoid overwriting a concurrent editor's change.
    const current = await readConfig(path);
    if (current.text !== before.text) throw new Error("Hook configuration changed during installation; retry after the other writer finishes.");
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
  return [`${path}:`, ...changes.map(change => `  + ${change}`)];
}

export async function hooksStatus(harness: Harness, scope: Scope, home = homedir(), cwd = process.cwd()): Promise<string[]> {
  const path = hooksPath(harness, scope, home, cwd);
  const { config } = await readConfig(path);
  const events = Object.entries(config.hooks).flatMap(([event, groups]) => groups.flatMap(group => group.hooks.filter(hook => hook.type === "mcp_tool" && hook.server === "aceteam").map(hook => `${event}${group.matcher ? ` (${group.matcher})` : ""}: ${String(hook.tool)}`)));
  let configured = false;
  if (harness === "codex") {
    for (const base of [home, cwd]) {
      const text = await readFile(join(base, ".codex", "config.toml"), "utf8").catch(() => "");
      configured ||= /^\s*\[\s*mcp_servers\.(?:aceteam|"aceteam"|'aceteam')\s*\]/m.test(text);
    }
  } else {
    const paths = [join(cwd, ".mcp.json"), join(home, ".claude.json")];
    for (const candidate of paths) {
      try {
        const value: unknown = JSON.parse(await readFile(candidate, "utf8"));
        if (!object(value)) continue;
        configured ||= object(value.mcpServers) && object(value.mcpServers.aceteam);
        if (object(value.projects) && object(value.projects[cwd])) {
          const project = value.projects[cwd];
          configured ||= object(project.mcpServers) && object(project.mcpServers.aceteam);
        }
      } catch { /* Status does not print credentials or configuration contents. */ }
    }
  }
  return [path, ...events, `aceteam MCP server: ${configured ? "configured" : "not found"}`, ...(harness === "codex" ? ["Codex requires hook trust review. MCP SessionEnd hooks are currently unsupported."] : [])];
}

function harnessOption(value: string): Harness {
  if (value !== "claude-code" && value !== "codex") throw new Error("Harness must be claude-code or codex.");
  return value;
}
function scopeOption(value: string): Scope {
  if (value !== "user" && value !== "project") throw new Error("Scope must be user or project.");
  return value;
}
export const hooksCommand = new Command("hooks").description("Install and inspect AceTeam harness liveness hooks");
for (const operation of ["install", "status"]) {
  const command = hooksCommand.command(operation).requiredOption("--harness <harness>", "claude-code or codex", harnessOption).option("--scope <scope>", "user or project", scopeOption, "user");
  if (operation === "install") command.option("--name <name>", "Dedicated launcher name; default derives each session name from its cwd");
  command.action(async (options: { harness: Harness; scope: Scope; name?: string }) => {
    try {
      const lines = operation === "install" ? await installHooks(options.harness, options.scope, options.name) : await hooksStatus(options.harness, options.scope);
      process.stdout.write(`${lines.join("\n")}\n`);
      if (operation === "install" && options.harness === "codex") process.stdout.write("Review and trust the installed hooks in Codex. MCP SessionEnd hooks are currently unsupported.\n");
    } catch (error) { command.error((error as Error).message); }
  });
}
