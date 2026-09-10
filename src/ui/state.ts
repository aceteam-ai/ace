import type { ProviderInfo } from "../utils/provider-detect.js";
import type { ProgressEvent } from "../utils/python.js";
import type { WorkflowInputField } from "./workflow-form.js";

export type WorkspaceScreen =
  | "home" | "tasks" | "task-input" | "workflow" | "workflow-values" | "templates" | "template-detail"
  | "template-output" | "settings" | "settings-edit" | "provider" | "running" | "result" | "help"
  | `panel:${string}`;

export interface WorkspaceProgress {
  message: string;
  event?: ProgressEvent;
}

export interface WorkspaceState {
  screen: WorkspaceScreen;
  returnTo: WorkspaceScreen;
  selected: number;
  selectedId?: string;
  input: string;
  provider?: ProviderInfo;
  providerReady: boolean;
  progress: WorkspaceProgress[];
  result?: { title: string; input?: string; output: string; sample?: boolean };
  error?: string;
  workflowPath?: string;
  workflowFields?: WorkflowInputField[];
  workflowValues?: Record<string, unknown>;
  formError?: string;
  templateQuery: string;
  helpReturn?: { screen: WorkspaceScreen; returnTo: WorkspaceScreen; selected: number; selectedId?: string; input: string };
}

export const initialWorkspaceState: WorkspaceState = {
  screen: "tasks",
  returnTo: "home",
  selected: 0,
  input: "",
  providerReady: false,
  progress: [],
  templateQuery: "",
};

export type WorkspaceAction =
  | { type: "navigate"; screen: WorkspaceScreen; returnTo?: WorkspaceScreen; selectedId?: string; input?: string }
  | { type: "select"; index: number }
  | { type: "input"; value: string }
  | { type: "provider"; provider: ProviderInfo }
  | { type: "workflow-inputs"; path: string; fields: WorkflowInputField[] }
  | { type: "workflow-value"; field: string; include: boolean; value?: unknown }
  | { type: "form-error"; message: string }
  | { type: "template-query"; value: string }
  | { type: "run"; message: string }
  | { type: "progress"; progress: WorkspaceProgress }
  | { type: "result"; title: string; output: string; input?: string; sample?: boolean }
  | { type: "error"; message: string }
  | { type: "help" }
  | { type: "back" };

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "navigate":
      return { ...state, screen: action.screen, returnTo: action.returnTo ?? state.screen, selected: 0, selectedId: action.selectedId, input: action.input ?? "", error: undefined, formError: undefined };
    case "select": return { ...state, selected: Math.max(0, action.index) };
    case "input": return { ...state, input: action.value, error: undefined, formError: undefined };
    case "provider": return { ...state, provider: action.provider, providerReady: true };
    case "workflow-inputs": return { ...state, screen: "workflow-values", returnTo: "workflow", selected: 0, input: "", workflowPath: action.path, workflowFields: action.fields, workflowValues: {}, formError: undefined };
    case "workflow-value": {
      const workflowValues = { ...state.workflowValues };
      if (action.include) workflowValues[action.field] = action.value;
      return { ...state, input: "", selected: state.selected + 1, workflowValues, formError: undefined };
    }
    case "form-error": return { ...state, formError: action.message };
    case "template-query": return { ...state, templateQuery: action.value, selected: 0 };
    case "run": return { ...state, screen: "running", progress: [{ message: action.message }], error: undefined };
    case "progress": return { ...state, progress: [...state.progress, action.progress].slice(-8) };
    case "result": return { ...state, screen: "result", selected: 0, result: action, error: undefined };
    case "error": return { ...state, screen: "result", selected: 0, result: undefined, error: action.message };
    case "help":
      if (state.screen === "help" && state.helpReturn) return { ...state, ...state.helpReturn, helpReturn: undefined };
      return { ...state, screen: "help", helpReturn: { screen: state.screen, returnTo: state.returnTo, selected: state.selected, selectedId: state.selectedId, input: state.input } };
    case "back": return { ...state, screen: state.returnTo, selected: 0, input: "", error: undefined, result: undefined };
  }
}
