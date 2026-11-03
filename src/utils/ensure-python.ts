import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import {
  createVenv,
  getPythonVersion,
  getVenvPythonPath,
  installAceteamNodes,
  isAceteamNodesReady,
  type OperationOptions,
} from "./python.js";

interface BootstrapFlight {
  controller: AbortController;
  promise: Promise<string>;
  consumers: Set<symbol>;
  progress: Set<(message: string) => void>;
}
let inFlight: BootstrapFlight | undefined;

function abortError(): Error {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function supportedPython(path: string): boolean {
  if (!existsSync(path)) return false;
  const version = getPythonVersion(path);
  return Boolean(version?.major === 3 && version.minor >= 12);
}

async function ready(path: string | undefined, signal?: AbortSignal): Promise<boolean> {
  return Boolean(path && supportedPython(path) && await isAceteamNodesReady(path, signal));
}

async function bootstrap(options: OperationOptions): Promise<string> {
  const config = loadConfig();
  const legacyDir = join(homedir(), ".ace", "venv");
  const venvDir = config.venv_dir && config.venv_dir !== legacyDir
    ? config.venv_dir : join(homedir(), ".ace", "venv-workflow2-rc16");
  const managedPython = getVenvPythonPath(venvDir);

  if (await ready(config.python_path, options.signal)) return config.python_path!;
  if (await ready(managedPython, options.signal)) {
    saveConfig({ ...config, python_path: managedPython, venv_dir: venvDir });
    return managedPython;
  }

  if (!supportedPython(managedPython)) {
    await createVenv(null, venvDir, options);
    if (!supportedPython(managedPython)) throw new Error("Managed Python 3.12 environment was not created correctly");
  }

  if (!await isAceteamNodesReady(managedPython, options.signal)) {
    await installAceteamNodes(managedPython, options);
  }
  if (!await isAceteamNodesReady(managedPython, options.signal)) {
    throw new Error("Ace workflow runtime installation did not pass its version and import readiness check");
  }

  saveConfig({ ...config, python_path: managedPython, venv_dir: venvDir });
  return managedPython;
}

function joinFlight(flight: BootstrapFlight, options: OperationOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(abortError());
  const token = Symbol("bootstrap-consumer");
  flight.consumers.add(token);
  if (options.onProgress) flight.progress.add(options.onProgress);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      flight.consumers.delete(token);
      if (options.onProgress) flight.progress.delete(options.onProgress);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (flight.consumers.size === 0) flight.controller.abort();
      reject(abortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    flight.promise.then(
      (path) => { if (!settled) { settled = true; cleanup(); resolve(path); } },
      (error) => { if (!settled) { settled = true; cleanup(); reject(error); } }
    );
  });
}

export async function ensurePython(options: OperationOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw abortError();
  const config = loadConfig();
  if (await ready(config.python_path, options.signal)) return config.python_path!;

  if (!inFlight) {
    const controller = new AbortController();
    const flight: BootstrapFlight = { controller, consumers: new Set(), progress: new Set(), promise: Promise.resolve("") };
    flight.promise = bootstrap({
      signal: controller.signal,
      onProgress: (message) => { for (const listener of flight.progress) listener(message); },
    }).finally(() => { if (inFlight === flight) inFlight = undefined; });
    inFlight = flight;
  }
  return joinFlight(inFlight, options);
}

/** Test hook; production calls naturally clear the flight after every attempt. */
export function resetPythonBootstrapForTests(): void {
  inFlight?.controller.abort();
  inFlight = undefined;
}
