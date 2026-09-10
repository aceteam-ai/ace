import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import which from "which";
import { loadConfig } from "./config.js";

export const UV_VERSION = "0.12.12";
export const ACETEAM_NODES_SPEC = "aceteam-nodes[llm]==0.5.1";
export const WORKFLOW_ENGINE_SPEC = "aceteam-workflow-engine==2.0.0rc8";
const UV_INSTALLER_SHA256 = {
  win32: "00b69ae502ad6a6c5af9d606559a29f218374f086cafa89bc2f6408a1f3e24b5",
  default: "f4f45f7f5f213d96efc1978b8772b2c037d495d9161ffa7468f8167c6b031033",
} as const;

export interface OperationOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function abortError(): Error {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

interface ProcessResult { stdout: string; stderr: string; code: number | null }

function runProcess(
  command: string,
  args: string[],
  options: OperationOptions & { env?: NodeJS.ProcessEnv; onStderr?: (text: string) => void } = {}
): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const appendBounded = (current: string, chunk: string) => (current + chunk).slice(-10 * 1024 * 1024);
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceTimer.unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout?.on("data", (data: Buffer) => { stdout = appendBounded(stdout, data.toString()); });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr = appendBounded(stderr, text);
      options.onStderr?.(text);
    });
    child.once("error", (error) => finish(() => reject(aborted ? abortError() : error)));
    child.once("close", (code) => finish(() => aborted ? reject(abortError()) : resolve({ stdout, stderr, code })));
  });
}
function managedUvPath(): string {
  return join(homedir(), ".ace", "bin", process.platform === "win32" ? "uv.exe" : "uv");
}

export async function findUv(): Promise<string | null> {
  const managed = managedUvPath();
  if (existsSync(managed)) return managed;
  try { return await which("uv"); } catch { return null; }
}

/** Download the versioned official installer, verify it, then install into Ace's own bin dir. */
export async function ensureUv(options: OperationOptions = {}): Promise<string> {
  const existing = await findUv();
  if (existing) return existing;
  throwIfAborted(options.signal);
  options.onProgress?.(`Downloading uv ${UV_VERSION}`);

  const windows = process.platform === "win32";
  const asset = windows ? "uv-installer.ps1" : "uv-installer.sh";
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`Could not download uv installer (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  const expected = windows ? UV_INSTALLER_SHA256.win32 : UV_INSTALLER_SHA256.default;
  if (digest !== expected) throw new Error("uv installer checksum verification failed");

  const tempDir = await mkdtemp(join(tmpdir(), "ace-uv-"));
  const installer = join(tempDir, asset);
  const installDir = join(homedir(), ".ace", "bin");
  try {
    await mkdir(installDir, { recursive: true });
    await writeFile(installer, bytes, { mode: 0o700 });
    options.onProgress?.(`Installing uv ${UV_VERSION}`);
    const env = { ...process.env, UV_UNMANAGED_INSTALL: installDir, UV_DISABLE_UPDATE: "1", UV_NO_MODIFY_PATH: "1" };
    const result = windows
      ? await runProcess("powershell.exe", powerShellInstallerArgs(installer), { ...options, env })
      : await runProcess("sh", [installer], { ...options, env });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "uv installer failed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  const installed = managedUvPath();
  if (!existsSync(installed)) throw new Error("uv installer completed without producing an executable");
  return installed;
}

function powerShellInstallerArgs(installer: string): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer];
}

export interface PythonVersion { major: number; minor: number; patch: number }

export function getPythonVersion(pythonPath: string): PythonVersion | null {
  try {
    const text = execFileSync(pythonPath, ["--version"], { encoding: "utf-8" }).trim();
    const match = text.match(/Python (\d+)\.(\d+)\.(\d+)/);
    return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
  } catch { return null; }
}

export async function findPython(): Promise<string | null> {
  for (const name of ["python3", "python"]) {
    try {
      const path = await which(name);
      const version = getPythonVersion(path);
      if (version?.major === 3 && version.minor >= 12) return path;
    } catch { /* keep looking */ }
  }
  return null;
}

export function getVenvPythonPath(venvDir: string): string {
  return join(venvDir, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
}

export function isVenvValid(venvDir: string): boolean { return existsSync(getVenvPythonPath(venvDir)); }

export function isAceteamNodesInstalled(pythonPath: string): boolean {
  try {
    execFileSync(pythonPath, ["-m", "aceteam_nodes.cli", "list-nodes"], { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch { return false; }
}

export async function isAceteamNodesReady(pythonPath: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await runProcess(pythonPath, ["-m", "aceteam_nodes.cli", "list-nodes"], { signal });
    return result.code === 0 && result.stdout.trim().length > 0;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return false;
  }
}


export async function createVenv(pythonPath: string | null, venvDir: string, options?: OperationOptions): Promise<void> {
  const uvPath = options ? await ensureUv(options) : await findUv();
  if (uvPath) {
    const args = ["venv", venvDir, "--python", pythonPath ?? "3.12"];
    if (options && existsSync(venvDir)) args.push("--clear");
    if (!options) { execFileSync(uvPath, args, { stdio: "pipe" }); return; }
    options.onProgress?.("Creating managed Python 3.12 environment");
    const result = await runProcess(uvPath, args, options);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not create Python environment");
    return;
  }
  if (!pythonPath) throw new Error("No Python found and uv is not installed");
  if (!options) { execFileSync(pythonPath, ["-m", "venv", venvDir], { stdio: "pipe" }); return; }
  const result = await runProcess(pythonPath, ["-m", "venv", venvDir], options);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not create Python environment");
}

export async function installAceteamNodes(pythonPath: string, options?: OperationOptions): Promise<void> {
  const uvPath = options ? await ensureUv(options) : await findUv();
  if (uvPath) {
    const args = ["pip", "install", ACETEAM_NODES_SPEC, WORKFLOW_ENGINE_SPEC, "--python", pythonPath];
    if (!options) { execFileSync(uvPath, args, { stdio: ["ignore", "inherit", "inherit"] }); return; }
    options.onProgress?.("Installing the Ace workflow runtime");
    const result = await runProcess(uvPath, args, options);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not install the Ace workflow runtime");
    return;
  }
  const configuredVenv = loadConfig().venv_dir ?? join(homedir(), ".ace", "venv");
  if (pythonPath === getVenvPythonPath(configuredVenv)) {
    // Explicit `ace init` may create the managed venv with stdlib first.
    execFileSync(pythonPath, ["-m", "pip", "install", ACETEAM_NODES_SPEC, WORKFLOW_ENGINE_SPEC], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    return;
  }
  // Never mutate a system or otherwise unmanaged interpreter.
  throw new Error("uv is required to install the managed Ace runtime");
}

export interface RunResult {
  success: boolean;
  output?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  error?: string;
  stderr?: string;
}
export interface ProgressEvent {
  type: "started" | "node_running" | "node_done" | "node_error";
  totalNodes?: number;
  currentNode?: number;
  nodeName?: string;
  message?: string;
}
export function parseProgressLine(line: string): ProgressEvent | null {
  const started = line.match(/Workflow started\s*\((\d+)\s*nodes?\)/i);
  if (started) return { type: "started", totalNodes: Number(started[1]) };
  const running = line.match(/\[([^\]]+)\]\s*running/i);
  if (running) return { type: "node_running", nodeName: running[1] };
  const done = line.match(/\[([^\]]+)\]\s*done/i);
  if (done) return { type: "node_done", nodeName: done[1] };
  const failed = line.match(/\[([^\]]+)\]\s*error:\s*(.*)/i);
  return failed ? { type: "node_error", nodeName: failed[1], message: failed[2] } : null;
}
export interface RunOptions {
  verbose?: boolean;
  config?: string;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

function providerEnvironment(): NodeJS.ProcessEnv {
  const config = loadConfig();
  return {
    ...process.env,
    ...(process.env.OPENAI_API_KEY || !config.api_keys?.openai ? {} : { OPENAI_API_KEY: config.api_keys.openai }),
    ...(process.env.ANTHROPIC_API_KEY || !config.api_keys?.anthropic ? {} : { ANTHROPIC_API_KEY: config.api_keys.anthropic }),
  };
}

export async function runWorkflow(
  pythonPath: string,
  filePath: string,
  input: Record<string, string>,
  options: RunOptions = {}
): Promise<RunResult> {
  const args = ["-m", "aceteam_nodes.cli", "run", filePath, "--input", JSON.stringify(input), "--verbose"];
  if (options.config) args.push("--config", options.config);
  let completedNodes = 0;
  let totalNodes = 0;
  let pending = "";
  const result = await runProcess(pythonPath, args, {
    signal: options.signal,
    env: providerEnvironment(),
    onStderr: (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseProgressLine(line.trim());
        if (!event) continue;
        if (event.type === "started") totalNodes = event.totalNodes ?? 0;
        if (event.type === "node_done") completedNodes++;
        if (event.type === "node_running") event.currentNode = completedNodes + 1;
        if (event.type === "node_done") event.currentNode = completedNodes;
        event.totalNodes ??= totalNodes;
        options.onProgress?.(event);
      }
      if (options.verbose) process.stderr.write(chunk);
    },
  });
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  try {
    const parsed = JSON.parse(stdout || stderr) as RunResult;
    parsed.stderr = result.stderr;
    return parsed;
  } catch {
    return { success: false, error: stdout || stderr || `Process exited with code ${result.code}`, stderr: result.stderr };
  }
}

async function simplePythonCommand(pythonPath: string, args: string[]): Promise<Record<string, unknown>> {
  const result = await runProcess(pythonPath, args, { env: providerEnvironment() });
  try { return JSON.parse(result.stdout) as Record<string, unknown>; }
  catch { return { error: result.stderr.trim() || "Failed to parse Python output" }; }
}
export function validateWorkflow(pythonPath: string, filePath: string): Promise<Record<string, unknown>> {
  return simplePythonCommand(pythonPath, ["-m", "aceteam_nodes.cli", "validate", filePath]);
}
export function listNodes(pythonPath: string): Promise<Record<string, unknown>> {
  return simplePythonCommand(pythonPath, ["-m", "aceteam_nodes.cli", "list-nodes"]);
}
