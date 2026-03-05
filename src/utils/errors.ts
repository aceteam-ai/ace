import type { RunResult } from "./python.js";

export interface ClassifiedError {
  message: string;
  suggestion?: string;
}

/**
 * Classify a RunResult into a human-readable error.
 * Handles the common case where workflow_errors contains [null] but the
 * actual error (e.g. AuthenticationError) is in stderr.
 */
export function classifyWorkflowError(result: RunResult): ClassifiedError {
  // Direct error string from Python
  if (result.error) {
    return classifyPythonError(result.error);
  }

  // Check for non-null messages in node_errors
  if (result.errors) {
    const nodeErrors = (result.errors as Record<string, unknown>).node_errors as
      | Record<string, string | null>
      | undefined;
    if (nodeErrors) {
      const messages = Object.entries(nodeErrors)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}: ${v}`);
      if (messages.length > 0) {
        return { message: messages.join("\n") };
      }
    }

    // workflow_errors has null values — the real error is in stderr
    const workflowErrors = (result.errors as Record<string, unknown>)
      .workflow_errors as Array<string | null> | undefined;
    const hasOnlyNulls =
      workflowErrors &&
      workflowErrors.length > 0 &&
      workflowErrors.every((e) => e == null);

    if (hasOnlyNulls && result.stderr) {
      return classifyPythonError(result.stderr);
    }

    // Non-null workflow errors
    if (workflowErrors) {
      const nonNull = workflowErrors.filter((e) => e != null);
      if (nonNull.length > 0) {
        return classifyPythonError(nonNull.join("\n"));
      }
    }
  }

  // Last resort: try stderr
  if (result.stderr) {
    return classifyPythonError(result.stderr);
  }

  return { message: "Unknown error occurred." };
}

/**
 * Classify raw Python stderr/error output into human-readable messages.
 */
export function classifyPythonError(raw: string): ClassifiedError {
  // ModuleNotFoundError — missing aceteam-nodes or dependencies
  if (raw.includes("ModuleNotFoundError")) {
    const moduleMatch = raw.match(/ModuleNotFoundError: No module named '([^']+)'/);
    const moduleName = moduleMatch?.[1] ?? "unknown";
    if (moduleName.includes("aceteam_nodes")) {
      return {
        message: `Python module "aceteam_nodes" is not installed.`,
        suggestion: "Run `ace init` to install dependencies.",
      };
    }
    return {
      message: `Missing Python module: ${moduleName}`,
      suggestion: "Run `ace init` to reinstall dependencies.",
    };
  }

  // Authentication errors — missing or invalid API key
  if (
    raw.includes("AuthenticationError") ||
    raw.includes("api_key") ||
    raw.includes("API key") ||
    raw.includes("Incorrect API key")
  ) {
    return {
      message: "API authentication failed.",
      suggestion:
        "Set your API key: export OPENAI_API_KEY=sk-... or export ANTHROPIC_API_KEY=sk-ant-...",
    };
  }

  // Pydantic validation errors
  if (raw.includes("ValidationError") && raw.includes("validation error")) {
    const fieldErrors = extractPydanticFields(raw);
    if (fieldErrors.length > 0) {
      return {
        message: `Validation failed:\n${fieldErrors.map((f) => `  - ${f}`).join("\n")}`,
      };
    }
    return {
      message: "Input validation failed. Check your workflow inputs.",
    };
  }

  // Connection errors
  if (
    raw.includes("ConnectionError") ||
    raw.includes("ConnectError") ||
    raw.includes("ECONNREFUSED") ||
    raw.includes("httpx.ConnectError")
  ) {
    return {
      message: "Network connection failed.",
      suggestion: "Check your internet connection and try again.",
    };
  }

  // File not found
  if (
    raw.includes("FileNotFoundError") ||
    raw.includes("WorkflowFileNotFoundError")
  ) {
    const pathMatch = raw.match(/(?:No such file or directory|not found)[:\s]*'?([^'\n]+)'?/);
    return {
      message: pathMatch
        ? `File not found: ${pathMatch[1].trim()}`
        : "Workflow file not found.",
      suggestion: "Verify the file path and try again.",
    };
  }

  // Timeout errors
  if (raw.includes("TimeoutError") || raw.includes("timed out")) {
    return {
      message: "Operation timed out.",
      suggestion: "Try again or check if the model endpoint is responding.",
    };
  }

  // Rate limiting
  if (raw.includes("RateLimitError") || raw.includes("rate_limit") || raw.includes("429")) {
    return {
      message: "Rate limited by the API provider.",
      suggestion: "Wait a moment and try again.",
    };
  }

  // Default: strip Python traceback, show last meaningful line
  return {
    message: extractLastMeaningfulLine(raw),
  };
}

/**
 * Extract field-level messages from Pydantic ValidationError output.
 */
function extractPydanticFields(raw: string): string[] {
  const fields: string[] = [];
  // Pydantic v2 format: "  field_name\n    Error message [type=..., ...]"
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^\s{2}\S/) && i + 1 < lines.length) {
      const fieldName = line.trim();
      const errorLine = lines[i + 1]?.trim();
      if (errorLine && !errorLine.startsWith("For further")) {
        fields.push(`${fieldName}: ${errorLine.replace(/\s*\[type=.*\]/, "")}`);
      }
    }
  }
  return fields;
}

/**
 * Strip Python traceback and return the last meaningful error line.
 */
function extractLastMeaningfulLine(raw: string): string {
  const lines = raw.trim().split("\n");

  // Walk backwards to find the last non-traceback line
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (
      line &&
      !line.startsWith("Traceback") &&
      !line.startsWith("File ") &&
      !line.startsWith("^") &&
      !line.startsWith("~~~") &&
      !line.startsWith("During handling")
    ) {
      return line;
    }
  }

  return raw.trim().slice(0, 200);
}
