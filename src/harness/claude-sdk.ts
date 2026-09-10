import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export const TESTED_CLAUDE_AGENT_SDK_VERSION = "0.3.267";
export const TESTED_CLAUDE_CODE_VERSION = "2.1.267";

export type ClaudeSdkMessage = SDKMessage;
export type ClaudeSdkUserMessage = SDKUserMessage;

export interface ClaudeQuery extends AsyncGenerator<ClaudeSdkMessage, void> {
  initializationResult(): Promise<{
    account?: {
      apiKeySource?: string;
      apiProvider?: string;
      tokenSource?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  interrupt(): Promise<{ still_queued?: string[]; cancelled?: string[] } | undefined>;
  close(): void;
}

export interface ClaudeQueryOptions {
  cwd: string;
  abortController: AbortController;
  env: Record<string, string | undefined>;
  settingSources: ["user", "project", "local"];
  includePartialMessages: true;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
      requestId: string;
      matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
    },
  ) => Promise<
    | { behavior: "allow"; updatedInput: Record<string, unknown>; toolUseID: string }
    | { behavior: "deny"; message: string; toolUseID: string }
  >;
  agentProgressSummaries: false;
  promptSuggestions: false;
  permissionMode: "default" | "plan" | "dontAsk";
  model?: string;
  sessionId?: string;
  resume?: string;
}

export interface ClaudeResolvedSettings {
  effective: Record<string, unknown>;
  sources: Array<{ source: string; settings: Record<string, unknown>; path?: string; policyOrigin?: string }>;
  [key: string]: unknown;
}

export interface ClaudeSdkBoundary {
  query(params: {
    prompt: AsyncIterable<ClaudeSdkUserMessage>;
    options: ClaudeQueryOptions;
  }): ClaudeQuery;
  getSessionInfo(
    sessionId: string,
    options: { dir: string },
  ): Promise<{ sessionId: string; cwd?: string; [key: string]: unknown } | undefined>;
  resolveSettings(options: { cwd: string; settingSources: ["user", "project", "local"] }): Promise<ClaudeResolvedSettings>;
  filterEscalatingDefaultMode(resolved: ClaudeResolvedSettings): Record<string, unknown>;
}

export type ClaudeSdkFactory = () => Promise<ClaudeSdkBoundary>;

export const loadClaudeSdk: ClaudeSdkFactory = async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params) => sdk.query(params as Parameters<typeof sdk.query>[0]) as ClaudeQuery,
    getSessionInfo: (sessionId, options) => sdk.getSessionInfo(sessionId, options),
    resolveSettings: (options) => sdk.resolveSettings(options) as Promise<ClaudeResolvedSettings>,
    filterEscalatingDefaultMode: (resolved) => sdk.filterEscalatingDefaultMode(resolved as Parameters<typeof sdk.filterEscalatingDefaultMode>[0]) as Record<string, unknown>,
  };
};
