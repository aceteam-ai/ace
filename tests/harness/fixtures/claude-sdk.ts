import type {
  ClaudeQuery, ClaudeQueryOptions, ClaudeResolvedSettings, ClaudeSdkBoundary, ClaudeSdkMessage, ClaudeSdkUserMessage,
} from "../../../src/harness/claude-sdk.js";
import { ClaudeInputQueue } from "../../../src/harness/claude-input-queue.js";

export type SyntheticMessage = Record<string, any>;

export class SyntheticClaudeQuery implements ClaudeQuery {
  readonly output = new ClaudeInputQueue<ClaudeSdkMessage>();
  readonly inputs: ClaudeSdkUserMessage[] = [];
  readonly inputIterator: AsyncIterator<ClaudeSdkUserMessage>;
  closed = false;
  returned = false;
  interruptReceipt: { still_queued?: string[]; cancelled?: string[] } | undefined = {};
  interruptError?: Error;
  closeCalls = 0;
  returnCalls = 0;
  returnError?: Error;
  closeError?: Error;
  initialization = Promise.resolve({ account: { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty", tokenSource: "synthetic-unused" } });

  constructor(prompt: AsyncIterable<ClaudeSdkUserMessage>) {
    this.inputIterator = prompt[Symbol.asyncIterator]();
  }

  async takeInput(): Promise<ClaudeSdkUserMessage> {
    const item = await this.inputIterator.next();
    if (item.done) throw new Error("Synthetic input queue closed");
    this.inputs.push(item.value);
    return item.value;
  }

  emit(message: SyntheticMessage): void {
    this.output.push(message as ClaudeSdkMessage);
  }

  initializationResult() { return this.initialization; }
  async interrupt() {
    if (this.interruptError) throw this.interruptError;
    return this.interruptReceipt;
  }
  close(): void { this.closeCalls++; if (this.closeError) throw this.closeError; this.closed = true; this.output.close(); }
  async next(): Promise<IteratorResult<ClaudeSdkMessage, void>> { return this.output[Symbol.asyncIterator]().next(); }
  async return(): Promise<IteratorResult<ClaudeSdkMessage, void>> {
    this.returnCalls++;
    this.returned = true;
    if (this.returnError) throw this.returnError;
    this.output.close();
    return { done: true, value: undefined };
  }
  async throw(error?: unknown): Promise<IteratorResult<ClaudeSdkMessage, void>> { throw error; }
  [Symbol.asyncIterator](): AsyncGenerator<ClaudeSdkMessage, void> { return this; }
}

export class SyntheticClaudeSdk implements ClaudeSdkBoundary {
  initialization?: SyntheticClaudeQuery["initialization"];
  resolvedSettings: ClaudeResolvedSettings = { effective: {}, sources: [] };
  filteredSettings?: Record<string, unknown>;
  resolveSettingsError?: Error;
  resolveSettingsCalls: Array<{ cwd: string; settingSources: ["user", "project", "local"] }> = [];
  configureQuery?: (query: SyntheticClaudeQuery) => void;
  queryCalls: Array<{ prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeQueryOptions }> = [];
  queries: SyntheticClaudeQuery[] = [];
  sessionInfo: { sessionId: string; cwd?: string; [key: string]: unknown } | undefined;
  getSessionInfoCalls: Array<{ sessionId: string; options: { dir: string } }> = [];

  query(params: { prompt: AsyncIterable<ClaudeSdkUserMessage>; options: ClaudeQueryOptions }): SyntheticClaudeQuery {
    this.queryCalls.push(params);
    const query = new SyntheticClaudeQuery(params.prompt);
    if (this.initialization) query.initialization = this.initialization;
    this.configureQuery?.(query);
    this.queries.push(query);
    return query;
  }
  async getSessionInfo(sessionId: string, options: { dir: string }) {
    this.getSessionInfoCalls.push({ sessionId, options });
    return this.sessionInfo;
  }
  async resolveSettings(options: { cwd: string; settingSources: ["user", "project", "local"] }) {
    this.resolveSettingsCalls.push(options);
    if (this.resolveSettingsError) throw this.resolveSettingsError;
    return structuredClone(this.resolvedSettings);
  }
  filterEscalatingDefaultMode(resolved: ClaudeResolvedSettings) {
    return structuredClone(this.filteredSettings ?? resolved.effective);
  }
}
