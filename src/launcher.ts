import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

export interface LauncherCommand { command: string; args: string[] }
export interface HarnessManifest {
  id: string;
  name: string;
  description: string;
  detect: string;
  launch: LauncherCommand;
  install?: LauncherCommand;
  configure?: { description: string };
}
export interface LauncherAction { kind: "launch" | "install"; harness: HarnessManifest }

const defaults: HarnessManifest[] = [
  { id: "claude", name: "Claude Code", description: "Anthropic coding agent", detect: "claude", launch: { command: "claude", args: [] }, install: { command: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] }, configure: { description: "CLI arguments, including model when supported" } },
  { id: "codex", name: "Codex", description: "OpenAI coding agent", detect: "codex", launch: { command: "codex", args: [] }, install: { command: "npm", args: ["install", "-g", "@openai/codex"] }, configure: { description: "CLI arguments, including model when supported" } },
  { id: "opencode", name: "OpenCode", description: "Open source coding agent", detect: "opencode", launch: { command: "opencode", args: [] }, install: { command: "npm", args: ["install", "-g", "opencode-ai"] }, configure: { description: "CLI arguments" } },
  { id: "hermes", name: "Hermes", description: "Hermes agent CLI", detect: "hermes", launch: { command: "hermes", args: [] }, install: { command: "bash", args: ["-c", "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"] }, configure: { description: "CLI arguments" } },
  { id: "cline", name: "Cline", description: "Cline coding agent", detect: "cline", launch: { command: "cline", args: [] }, install: { command: "npm", args: ["install", "-g", "cline"] }, configure: { description: "CLI arguments" } },
  { id: "droid", name: "Droid", description: "Factory coding agent", detect: "droid", launch: { command: "droid", args: [] }, install: { command: "npm", args: ["install", "-g", "droid"] }, configure: { description: "CLI arguments" } },
  { id: "copilot", name: "Copilot", description: "GitHub Copilot CLI", detect: "copilot", launch: { command: "copilot", args: [] }, install: { command: "npm", args: ["install", "-g", "@github/copilot"] }, configure: { description: "CLI arguments" } },
];

export function launcherRegistryPath(home = homedir()): string { return join(home, ".ace", "launcher", "registry.json"); }
function validCommand(value: unknown): value is LauncherCommand {
  return typeof value === "object" && value !== null && typeof (value as LauncherCommand).command === "string" &&
    (value as LauncherCommand).command.length > 0 && Array.isArray((value as LauncherCommand).args) &&
    (value as LauncherCommand).args.every((arg) => typeof arg === "string");
}
function validManifest(value: unknown): value is HarnessManifest {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as HarnessManifest;
  return /^[a-z0-9-]{1,40}$/.test(entry.id) && typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= 80 &&
    typeof entry.description === "string" && entry.description.length <= 160 && typeof entry.detect === "string" && entry.detect.length > 0 &&
    validCommand(entry.launch) && (entry.install === undefined || validCommand(entry.install)) &&
    (entry.configure === undefined || (typeof entry.configure.description === "string" && entry.configure.description.length <= 160));
}
export function loadHarnesses(path = launcherRegistryPath()): HarnessManifest[] {
  if (!existsSync(path)) return defaults.map((entry) => structuredClone(entry));
  const file = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(file) || file.length > 30 || !file.every(validManifest)) throw new Error(`Invalid launcher registry: ${path}`);
  const entries = defaults.map((entry) => structuredClone(entry));
  for (const overlay of file) {
    const index = entries.findIndex((entry) => entry.id === overlay.id);
    if (index === -1) entries.push(overlay);
    else entries[index] = overlay;
  }
  return entries;
}
export function saveHarnessArgs(entry: HarnessManifest, args: string[], path = launcherRegistryPath()): void {
  if (!Array.isArray(args) || args.length > 32 || !args.every((arg) => typeof arg === "string" && arg.length <= 1000)) throw new Error("Arguments must be a JSON array of up to 32 strings");
  const overlays = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as unknown : [];
  if (!Array.isArray(overlays) || overlays.length > 30 || !overlays.every(validManifest)) throw new Error(`Invalid launcher registry: ${path}`);
  const updated = { ...entry, launch: { ...entry.launch, args } };
  const next = overlays.filter((item) => item.id !== entry.id);
  next.push(updated);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}
export function findOnPath(command: string, envPath = process.env.PATH ?? ""): string | undefined {
  const executable = (path: string) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
  if (isAbsolute(command)) return executable(command) ? command : undefined;
  if (command.includes("/") || command.includes("\\")) return undefined;
  for (const directory of envPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}
export async function runLauncherAction(action: LauncherAction, streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream } = {}): Promise<number> {
  const spec = action.kind === "launch" ? action.harness.launch : action.harness.install;
  if (!spec) throw new Error(`No installer configured for ${action.harness.name}`);
  if (!findOnPath(spec.command)) throw new Error(`Command unavailable: ${spec.command}`);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: [streams.stdin ?? "inherit", streams.stdout ?? "inherit", streams.stderr ?? "inherit"], shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}
