import Ajv from "ajv";
import addFormats from "ajv-formats";
import { loadConfig, saveConfig, type ControlPlaneSession } from "./config.js";

export const DEFAULT_MCP_URL = "https://aceteam.ai/mcp";

export function validateMcpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(2, "Control-plane URL must be a valid HTTPS URL or use local HTTP.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new CliError(2, "Control-plane URL must use HTTPS or local HTTP.");
  }
  return url.toString();
}

export class CliError extends Error {
  constructor(
    public readonly exitCode: 2 | 3 | 4,
    message: string,
  ) {
    super(message);
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(4, "The control plane returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

export function unwrapToolResult(result: McpResult): unknown {
  if (result.structuredContent !== undefined) {
    const structured = result.structuredContent;
    if (structured && typeof structured === "object" && !Array.isArray(structured) &&
        "acting_org_id" in structured && "result" in structured) {
      const value = (structured as { result: unknown }).result;
      if (typeof value === "string") {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return value;
        }
      }
      return value;
    }
    return structured;
  }
  const blocks = (result.content || []).filter((block) => block.type === "text");
  if (blocks.length === 1) {
    const text = blocks[0].text || "";
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return result.content || [];
}

export function validateToolArgs(tool: McpTool, args: Record<string, unknown>): void {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  let validate;
  try {
    validate = ajv.compile(tool.inputSchema);
  } catch {
    throw new CliError(4, "The live schema for " + tool.name + " cannot be validated.");
  }
  if (!validate(args)) {
    const detail = (validate.errors || [])
      .map((error) => (error.instancePath || "/") + " " + error.message)
      .join("; ");
    throw new CliError(2, "Invalid arguments for " + tool.name + ": " + detail);
  }
}

function parseRpcBody(contentType: string, body: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    const events = body
      .split(/\r?\n\r?\n/)
      .flatMap((event) =>
        event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim()),
      );
    for (const data of events) {
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.result !== undefined || parsed.error) return parsed;
      } catch {
        continue;
      }
    }
  } else {
    try {
      return JSON.parse(body) as JsonRpcResponse;
    } catch {
      // Fall through to the controlled error below.
    }
  }
  throw new CliError(4, "The control plane returned an invalid MCP response.");
}

export class ControlPlaneClient {
  private sessionId?: string;
  private protocolVersion = "2025-06-18";
  private nextId = 1;
  private ready = false;

  constructor(
    private session: ControlPlaneSession,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly persist: (session: ControlPlaneSession) => void = (updated) => {
      const config = loadConfig();
      config.control_plane = updated;
      saveConfig(config);
    },
    private readonly readSavedSession: () => ControlPlaneSession | undefined = () => loadConfig().control_plane,
  ) {
    validateMcpUrl(session.mcp_url);
  }

  get authKind(): ControlPlaneSession["kind"] {
    return this.session.kind;
  }

  private adoptRotatedSession(): boolean {
    const saved = this.readSavedSession();
    if (saved?.kind !== "oauth" || !saved.access_token || !saved.refresh_token ||
        saved.client_id !== this.session.client_id || saved.mcp_url !== this.session.mcp_url ||
        saved.refresh_token === this.session.refresh_token) return false;
    this.session = { ...saved, active_org_id: this.session.active_org_id ?? saved.active_org_id };
    this.ready = false;
    this.sessionId = undefined;
    return true;
  }

  private async refreshIfNeeded(force = false): Promise<void> {
    if (this.session.kind !== "oauth" || !this.session.refresh_token || !this.session.client_id) {
      if (force) throw new CliError(3, "Session expired. Run ace login again.");
      return;
    }
    if (!force && (!this.session.expires_at || Date.now() < this.session.expires_at - 60_000)) {
      return;
    }
    if (this.adoptRotatedSession()) return;
    const endpoint = new URL("/api/oauth/token", this.session.mcp_url);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.session.refresh_token,
      client_id: this.session.client_id,
      resource: this.session.mcp_url,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch {
      throw new CliError(4, "Could not reach the control plane.");
    }
    if (!response.ok) {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (this.adoptRotatedSession()) return;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new CliError(3, "Session expired. Run ace login again.");
    }
    const token = object(await response.json());
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
      throw new CliError(4, "The control plane returned an invalid token response.");
    }
    this.session = {
      ...this.session,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
    };
    this.persist(this.session);
    this.ready = false;
    this.sessionId = undefined;
  }

  private async post(payload: Record<string, unknown>, retry = true): Promise<JsonRpcResponse> {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + this.session.access_token,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.ready) headers["MCP-Protocol-Version"] = this.protocolVersion;
    let response: Response;
    try {
      response = await this.fetchImpl(this.session.mcp_url, {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      throw new CliError(4, "Could not reach the control plane.");
    }
    if (response.status === 401 && retry && this.session.kind === "oauth" &&
        payload.method !== "notifications/initialized") {
      await this.refreshIfNeeded(true);
      if (payload.method !== "initialize") {
        await this.connect();
        await this.restoreSelectedOrgAfterRefresh();
      }
      return this.post(payload, false);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CliError(3, "Control-plane access denied. Run ace login again or check your permissions.");
    }
    if (!response.ok) throw new CliError(4, "Control-plane request failed (HTTP " + response.status + ").");
    const minted = response.headers.get("Mcp-Session-Id");
    if (minted) this.sessionId = minted;
    if (response.status === 202 || payload.method === "notifications/initialized") return {};
    const rpc = parseRpcBody(response.headers.get("content-type") || "", await response.text());
    if (rpc.error) throw new CliError(4, rpc.error.message);
    return rpc;
  }

  async connect(): Promise<void> {
    if (this.ready) return;
    await this.refreshIfNeeded();
    const initialized = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: "ace-cli", version: "0.3.0" },
      },
    });
    const result = object(initialized.result);
    if (typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    this.ready = true;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    const rpc = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
    return rpc.result;
  }

  private async callAfterRefresh(name: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    const rpc = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }, false);
    const result = object(rpc.result) as McpResult;
    if (result.isError) throw new CliError(4, "Could not restore the selected organization.");
    return result;
  }

  private async restoreSelectedOrgAfterRefresh(): Promise<void> {
    const selected = this.session.active_org_id;
    if (!selected) return;
    const identity = object(unwrapToolResult(await this.callAfterRefresh("whoami")));
    if (identity.organization_id === selected) return;
    await this.callAfterRefresh("switch_active_org", { organization_id: selected });
    const restored = object(unwrapToolResult(await this.callAfterRefresh("whoami")));
    if (restored.organization_id !== selected) {
      throw new CliError(4, "The control plane did not switch to the selected organization.");
    }
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = object(await this.request("tools/list", cursor ? { cursor } : {}));
      if (!Array.isArray(result.tools)) {
        throw new CliError(4, "The control plane returned an invalid tool list.");
      }
      for (const value of result.tools) {
        const tool = object(value);
        if (typeof tool.name === "string") tools.push(tool as unknown as McpTool);
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (cursor && seen.has(cursor)) throw new CliError(4, "The control plane repeated a tool cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return tools;
  }

  async getTool(name: string): Promise<McpTool> {
    const tool = (await this.listTools()).find((entry) => entry.name === name);
    if (!tool) throw new CliError(2, "Tool " + name + " is not in the live MCP schema.");
    return tool;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    const result = object(await this.request("tools/call", { name, arguments: args })) as McpResult;
    if (result.isError) {
      const detail = (result.content || [])
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("\n");
      throw new CliError(4, detail || "Tool " + name + " failed.");
    }
    return result;
  }

  async identity(): Promise<Record<string, unknown>> {
    return object(unwrapToolResult(await this.callTool("whoami")));
  }

  async ensureSelectedOrg(): Promise<Record<string, unknown>> {
    let identity = await this.identity();
    const selected = this.session.active_org_id;
    if (selected && identity.organization_id !== selected) {
      if (this.session.kind !== "oauth") {
        throw new CliError(3, "API-key organization changed. Run ace login again.");
      }
      await this.callTool("switch_active_org", { organization_id: selected });
      identity = await this.identity();
      if (identity.organization_id !== selected) {
        throw new CliError(4, "The control plane did not switch to the selected organization.");
      }
    }
    return identity;
  }

  selectOrg(organizationId: string): void {
    this.session = { ...this.session, active_org_id: organizationId };
    this.persist(this.session);
  }
}

export function configuredClient(fetchImpl: typeof fetch = fetch): ControlPlaneClient {
  const session = loadConfig().control_plane;
  if (!session?.access_token) throw new CliError(3, "Not logged in. Run ace login.");
  return new ControlPlaneClient(session, fetchImpl);
}
