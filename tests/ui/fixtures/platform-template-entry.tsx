import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { startInteractive } from "../../../src/commands/interactive.js";
import { createPlatformTemplatesPanel } from "../../../src/ui/PlatformTemplatesPanel.js";
import type { PlatformTemplateService } from "../../../src/ui/platform-template-service.js";
import type { WorkspaceTaskService } from "../../../src/ui/task-service.js";
import { SyntheticPlatformTemplates } from "./platform-template-scenario.js";

// Offline PTY entry. Only synthetic workspace/trace paths and scenario are accepted.
const [workspace, tracePath, scenario = "complete"] = process.argv.slice(2);
if (![workspace, tracePath].every((value) => value && isAbsolute(value)) || !["complete", "pending", "failed"].includes(scenario)) {
  throw new Error("Pass absolute synthetic workspace and trace paths, then complete, pending, or failed.");
}
const trace = (method: string, value: unknown = {}) => appendFileSync(tracePath, `${JSON.stringify({ method, value })}\n`, { mode: 0o600 });
const fixture = new SyntheticPlatformTemplates();
fixture.template.graph.input_node.params.fields.prompt.default = `${"Review the complete synthetic input.\n".repeat(30)}FINAL SYNTHETIC INPUT`;
fixture.template.description = "Synthetic template for offline terminal review. No network or model is used.";
fixture.execute = async (call) => {
  trace(call.mode === "remote" ? "remote" : "local", { workflowId: call.template.workflowId, versionNumber: call.template.versionNumber, workflowVersionId: call.template.workflowVersionId, input: call.input });
  if (scenario === "pending" && call.mode === "remote") {
    return new Promise((_, reject) => {
      const abort = () => { trace("abort", { mode: call.mode }); setTimeout(() => reject(Object.assign(new Error("Synthetic observation stopped."), { runId: "synthetic-pending-run", jobId: "synthetic-job" })), 25); };
      if (call.options.signal.aborted) abort(); else call.options.signal.addEventListener("abort", abort, { once: true });
    });
  }
  return { status: scenario === "failed" ? "failed" : "completed", workflowVersionId: call.template.workflowVersionId,
    ...(call.mode === "remote" ? { runId: "synthetic-run", jobId: "synthetic-job" } : {}),
    ...(scenario === "failed" ? { error: { message: "The platform reported an error with redacted details.", workflowErrors: [null], nodeErrors: {} } } : {}),
    output: { response: `# Synthetic ${call.mode} output\n\n${"Complete multiline output.\n".repeat(35)}FINAL SYNTHETIC OUTPUT` } };
};
const service: PlatformTemplateService = {
  list: (options) => { trace("catalog"); return fixture.list(options); },
  get: (summary, options) => {
    trace("get", { workflowId: summary.workflowId, versionNumber: summary.versionNumber });
    if (summary.workflowId !== fixture.template.workflowId) return Promise.reject(new Error("This listed template graph is inaccessible to this synthetic connection."));
    return fixture.get(summary, options);
  },
  runLocal: (template, input, options) => fixture.runLocal(template, input, options),
  runRemote: (template, input, options) => fixture.runRemote(template, input, options),
};
const workspaceService: WorkspaceTaskService = {
  detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [], getDemo: () => undefined,
  getConfig: () => ({}), getWorkflowInputs: () => [], executePattern: async () => "Synthetic fixture", executeWorkflow: async () => "Synthetic fixture",
  createWorkflow: () => "Synthetic fixture", updateDefaultModel: () => {},
};
const panel = createPlatformTemplatesPanel({ service });
const dispose = panel.dispose!; panel.dispose = async () => { await dispose(); trace("dispose"); };
await startInteractive({ service: workspaceService, panels: [panel] });
trace("exit", { workspace });
