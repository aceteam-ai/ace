import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { startInteractive } from "../../../src/commands/interactive.js";
import { NativeSessionManager } from "../../../src/harness/session-manager.js";
import { NativeSessionStore } from "../../../src/harness/session-store.js";
import { createNativeSessionsPanel } from "../../../src/ui/NativeSessionsPanel.js";
import type { WorkspaceTaskService } from "../../../src/ui/task-service.js";
import { SyntheticNativeAdapter } from "./native-ui-scenario.js";

// Offline PTY entry. All three arguments must point inside the driver's isolated fixture directory.
// The fake native history is seeded independently of local registration on each process start.
// No actual Codex process, credentials, network, or displayed command is used.
const [workspace, directory, tracePath] = process.argv.slice(2);
if (![workspace, directory, tracePath].every((value) => value && isAbsolute(value))) throw new Error("Pass absolute synthetic workspace, state directory, and trace file paths.");
const adapter = new SyntheticNativeAdapter({ adapterId: "codex", capabilities: { resume: { supported: true } }, nativeSessionId: () => "synthetic-native-thread" });
const history = await adapter.start({ type: "session.start", sessionId: "fixture-history", workspace });
if (history.status !== "ok") throw new Error("Synthetic history setup failed.");
await adapter.dispose({ type: "session.dispose", session: history.value });
const trace = (method: string, value: unknown) => appendFileSync(tracePath, `${JSON.stringify({ method, value })}\n`, { mode: 0o600 });
const start = adapter.start.bind(adapter); adapter.start = (command) => { trace("start", command); return start(command); };
const resume = adapter.resume.bind(adapter); adapter.resume = (command) => { trace("resume", command); return resume(command); };
const input = adapter.sendInput.bind(adapter); adapter.sendInput = (command) => { trace("input", command); return input(command); };
const approval = adapter.respondToApproval.bind(adapter); adapter.respondToApproval = (command) => { trace("approval", command); return approval(command); };
const dispose = adapter.dispose.bind(adapter); adapter.dispose = (command) => { trace("dispose", command); return dispose(command); };
const manager = new NativeSessionManager({ store: new NativeSessionStore({ directory }), adapters: { codex: () => adapter } });
const service: WorkspaceTaskService = {
  detectProvider: async () => ({ provider: null }), listPatterns: () => [], listTemplates: () => [],
  getDemo: () => undefined, getConfig: () => ({}), getWorkflowInputs: () => [],
  executePattern: async () => "Synthetic fixture only", executeWorkflow: async () => "Synthetic fixture only",
  createWorkflow: () => "Synthetic fixture only", updateDefaultModel: () => {},
};
await startInteractive({ service, panels: [createNativeSessionsPanel({ manager, workspace })] });
