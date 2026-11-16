import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePython } from "../utils/ensure-python.js";
import { validateNodeTypes } from "../utils/node-cache.js";
import { runWorkflow, type ProgressEvent, type RunResult } from "../utils/python.js";
import type { PlatformClient } from "./client.js";
import { validatePlatformTemplateInput } from "./input.js";
import type { PlatformTemplate } from "./types.js";

export { collectPlatformTemplateInput, platformTemplateInputFields, validatePlatformTemplateInput } from "./input.js";

export interface PlatformLocalRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  onSetupProgress?: (message: string) => void;
}


export async function runPlatformTemplateLocally(
  client: PlatformClient,
  template: PlatformTemplate,
  input: Record<string, unknown>,
  options: PlatformLocalRunOptions = {},
): Promise<RunResult> {
  client.assertAuthorizedTemplate(template);
  const validatedInput = validatePlatformTemplateInput(template, input);
  const python = await ensurePython({ signal: options.signal, onProgress: options.onSetupProgress });
  const directory = await mkdtemp(join(tmpdir(), "ace-platform-template-"));
  const graphPath = join(directory, "workflow.json");
  try {
    await chmod(directory, 0o700);
    await writeFile(graphPath, `${JSON.stringify(template.graph, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const { invalid, available } = await validateNodeTypes(python, graphPath);
    if (invalid.length > 0) {
      throw new Error(`This platform template is not compatible with the local runtime. Unknown node type${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}${available.length ? `. Available: ${available.join(", ")}` : ""}`);
    }
    return await runWorkflow(python, graphPath, validatedInput, {
      signal: options.signal,
      onProgress: options.onProgress,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
