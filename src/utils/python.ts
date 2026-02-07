import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import which from "which";

/**
 * Find a working Python 3.12+ executable.
 */
export async function findPython(): Promise<string | null> {
  const candidates = ["python3", "python"];

  for (const name of candidates) {
    try {
      const resolved = await which(name);
      const version = getPythonVersion(resolved);
      if (version && version.major === 3 && version.minor >= 12) {
        return resolved;
      }
    } catch {
      // Not found or can't execute
    }
  }

  return null;
}

export interface PythonVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Get the Python version from a given executable path.
 */
export function getPythonVersion(pythonPath: string): PythonVersion | null {
  try {
    const output = execSync(`${pythonPath} --version`, {
      encoding: "utf-8",
    }).trim();
    const match = output.match(/Python (\d+)\.(\d+)\.(\d+)/);
    if (match) {
      return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
      };
    }
  } catch {
    // Can't execute
  }
  return null;
}

/**
 * Create a Python virtual environment.
 */
export function createVenv(pythonPath: string, venvDir: string): void {
  execSync(`${pythonPath} -m venv ${venvDir}`, { stdio: "pipe" });
}

/**
 * Get the Python executable path inside a virtual environment.
 */
export function getVenvPythonPath(venvDir: string): string {
  if (process.platform === "win32") {
    return join(venvDir, "Scripts", "python.exe");
  }
  return join(venvDir, "bin", "python");
}

/**
 * Check if a virtual environment exists and is valid.
 */
export function isVenvValid(venvDir: string): boolean {
  const pythonPath = getVenvPythonPath(venvDir);
  return existsSync(pythonPath);
}

/**
 * Check if aceteam-nodes is installed and importable.
 */
export function isAceteamNodesInstalled(pythonPath: string): boolean {
  try {
    execSync(`${pythonPath} -c "import aceteam_nodes"`, {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install aceteam-nodes via pip.
 */
export function installAceteamNodes(pythonPath: string): void {
  execSync(`${pythonPath} -m pip install aceteam-nodes`, {
    stdio: "inherit",
  });
}

export interface RunResult {
  success: boolean;
  output?: Record<string, unknown>;
  errors?: Record<string, unknown>;
  error?: string;
}

export interface ProgressEvent {
  type: "started" | "node_running" | "node_done" | "node_error";
  totalNodes?: number;
  currentNode?: number;
  nodeName?: string;
  message?: string;
}

/**
 * Parse a stderr line into a structured progress event, if applicable.
 */
export function parseProgressLine(line: string): ProgressEvent | null {
  // "Workflow started (N nodes)"
  const startMatch = line.match(/Workflow started\s*\((\d+)\s*nodes?\)/i);
  if (startMatch) {
    return {
      type: "started",
      totalNodes: parseInt(startMatch[1], 10),
    };
  }

  // "[NodeType] running..."
  const runningMatch = line.match(/\[([^\]]+)\]\s*running/i);
  if (runningMatch) {
    return {
      type: "node_running",
      nodeName: runningMatch[1],
    };
  }

  // "[NodeType] done"
  const doneMatch = line.match(/\[([^\]]+)\]\s*done/i);
  if (doneMatch) {
    return {
      type: "node_done",
      nodeName: doneMatch[1],
    };
  }

  // "[NodeType] error: message"
  const errorMatch = line.match(/\[([^\]]+)\]\s*error:\s*(.*)/i);
  if (errorMatch) {
    return {
      type: "node_error",
      nodeName: errorMatch[1],
      message: errorMatch[2],
    };
  }

  return null;
}

export interface RunOptions {
  verbose?: boolean;
  config?: string;
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * Run a workflow via Python subprocess.
 * Streams stderr (progress) and collects stdout (JSON result).
 * Always passes --verbose to Python so progress events are available.
 */
export function runWorkflow(
  pythonPath: string,
  filePath: string,
  input: Record<string, string>,
  options: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      "aceteam_nodes.cli",
      "run",
      filePath,
      "--input",
      JSON.stringify(input),
      "--verbose",
    ];

    if (options.config) {
      args.push("--config", options.config);
    }

    const proc = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let completedNodes = 0;
    let totalNodes = 0;

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;

      // Parse progress events from each line
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const event = parseProgressLine(trimmed);
        if (event) {
          if (event.type === "started" && event.totalNodes) {
            totalNodes = event.totalNodes;
          }
          if (event.type === "node_done") {
            completedNodes++;
            event.currentNode = completedNodes;
            event.totalNodes = totalNodes;
          }
          if (event.type === "node_running") {
            event.currentNode = completedNodes + 1;
            event.totalNodes = totalNodes;
          }
          options.onProgress?.(event);
        }
      }

      // Stream raw stderr in verbose mode
      if (options.verbose) {
        process.stderr.write(text);
      }
    });

    proc.on("close", (code) => {
      try {
        // Try parsing stdout as JSON first
        if (stdout.trim()) {
          const result = JSON.parse(stdout) as RunResult;
          resolve(result);
        } else if (stderr.trim()) {
          // Try parsing stderr (error case)
          try {
            const result = JSON.parse(stderr) as RunResult;
            resolve(result);
          } catch {
            resolve({
              success: false,
              error: stderr.trim(),
            });
          }
        } else {
          resolve({
            success: false,
            error: `Process exited with code ${code}`,
          });
        }
      } catch {
        resolve({
          success: false,
          error: stdout || stderr || `Process exited with code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Validate a workflow via Python subprocess.
 */
export function validateWorkflow(
  pythonPath: string,
  filePath: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const args = ["-m", "aceteam_nodes.cli", "validate", filePath];

    const proc = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        resolve({ valid: false, error: "Failed to parse validation output" });
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * List available nodes via Python subprocess.
 */
export function listNodes(
  pythonPath: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const args = ["-m", "aceteam_nodes.cli", "list-nodes"];

    const proc = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on("close", () => {
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        resolve({ error: "Failed to parse node list output" });
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
