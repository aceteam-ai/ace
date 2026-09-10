import { startInteractive } from "../../../src/commands/interactive.js";
import { createNativeSessionsPanel } from "../../../src/ui/NativeSessionsPanel.js";
import type { WorkspaceTaskService } from "../../../src/ui/task-service.js";
import { SyntheticNativeAdapter } from "./native-ui-scenario.js";

const service: WorkspaceTaskService = {
  detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [],
  getDemo: () => undefined, getConfig: () => ({}), getWorkflowInputs: () => [],
  executePattern: async () => "Synthetic fixture only", executeWorkflow: async () => "Synthetic fixture only",
  createWorkflow: () => "Synthetic fixture only", updateDefaultModel: () => {},
};
await startInteractive({ service, panels: [createNativeSessionsPanel({ adapter: new SyntheticNativeAdapter(), workspace: "/synthetic/workspace" })] });
