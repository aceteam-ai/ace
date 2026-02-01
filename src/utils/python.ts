import { execSync, spawn } from "node:child_process";
import which from "which";

/**
 * Find a working Python 3.12+ executable.
 */
export async function findPython(): Promise<string | null> {
  const candidates = ["python3", "python"];

  for (const name of candidates) {
    try {
      const resolved = await which(name);
      const version = execSync(`${resolved} --version`, {
        encoding: "utf-8",
      }).trim();
      // Parse "Python 3.X.Y"
      const match = version.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major === 3 && minor >= 12) {
          return resolved;
        }
      }
    } catch {
      // Not found or can't execute
    }
  }

  return null;
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

/**
 * Run a workflow via Python subprocess.
 * Streams stderr (progress) and collects stdout (JSON result).
 */
export function runWorkflow(
  pythonPath: string,
  filePath: string,
  input: Record<string, string>,
  options: { verbose?: boolean; config?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      "aceteam_nodes.cli",
      "run",
      filePath,
      "--input",
      JSON.stringify(input),
    ];

    if (options.verbose) {
      args.push("--verbose");
    }
    if (options.config) {
      args.push("--config", options.config);
    }

    const proc = spawn(pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      // Stream progress messages to terminal
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
