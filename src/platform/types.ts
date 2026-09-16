import type { WorkflowGraph } from "../utils/workflow-graph.js";

export interface PlatformTemplateSummary {
  workflowId: string;
  title: string;
  description?: string;
  category?: string;
  versionNumber: number;
}

export interface PlatformTemplate extends PlatformTemplateSummary {
  workflowVersionId: string;
  graph: WorkflowGraph;
}

export interface PlatformRunErrorDetails {
  message?: string;
  workflowErrors: unknown[];
  nodeErrors: Record<string, unknown>;
}

export interface PlatformRunProgress {
  type: string;
  message?: string;
  nodeName?: string;
  currentNode?: number;
  totalNodes?: number;
  runId?: string;
  jobId?: string;
}

export interface PlatformRunResult {
  status: "completed" | "failed" | "cancelled";
  runId?: string;
  jobId?: string;
  workflowVersionId?: string;
  output?: unknown;
  error?: PlatformRunErrorDetails;
  lowCredits?: boolean;
}

export interface PlatformRequestOptions {
  signal?: AbortSignal;
}

export interface ListPlatformTemplatesOptions extends PlatformRequestOptions {
  category?: string;
}

export interface RunPlatformTemplateOptions extends PlatformRequestOptions {
  onProgress?: (progress: PlatformRunProgress) => void;
}
