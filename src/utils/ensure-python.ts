import { existsSync } from "node:fs";
import {
  findPython,
  isAceteamNodesInstalled,
  installAceteamNodes,
  getVenvPythonPath,
  isVenvValid,
} from "./python.js";
import { loadConfig } from "./config.js";
import * as output from "./output.js";

export async function ensurePython(): Promise<string> {
  const config = loadConfig();

  // Check config python_path first (managed venv)
  if (config.python_path && existsSync(config.python_path)) {
    if (isAceteamNodesInstalled(config.python_path)) {
      return config.python_path;
    }
  }

  // Check managed venv
  if (config.venv_dir && isVenvValid(config.venv_dir)) {
    const venvPython = getVenvPythonPath(config.venv_dir);
    if (isAceteamNodesInstalled(venvPython)) {
      return venvPython;
    }

    // Venv exists but aceteam-nodes missing — try to install
    output.warn("aceteam-nodes is not installed.");
    console.log("Installing aceteam-nodes...");
    try {
      await installAceteamNodes(venvPython);
      output.success("aceteam-nodes installed");
      return venvPython;
    } catch {
      output.error(
        "Failed to install aceteam-nodes. Try: ace init"
      );
      process.exit(1);
    }
  }

  // Fallback to PATH detection
  const pythonPath = await findPython();
  if (!pythonPath) {
    output.error(
      "Python 3.12+ not found. Run: ace init"
    );
    process.exit(1);
  }

  if (!isAceteamNodesInstalled(pythonPath)) {
    output.warn("aceteam-nodes is not installed.");
    console.log("Installing aceteam-nodes...");
    try {
      await installAceteamNodes(pythonPath);
      output.success("aceteam-nodes installed");
    } catch {
      output.error(
        "Failed to install aceteam-nodes. Run: ace init"
      );
      process.exit(1);
    }
  }

  return pythonPath;
}
