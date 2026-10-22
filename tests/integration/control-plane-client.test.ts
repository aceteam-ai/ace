import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CliError,
  ControlPlaneClient,
  validateMcpUrl,
  unwrapToolResult,
  validateToolArgs,
  type McpTool,
} from "../../src/utils/control-plane.js";
import { browserLogin } from "../../src/utils/oauth.js";
import { parseToolArgs } from "../../src/commands/control-plane.js";
import { runCli } from "../../src/utils/cli-output.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  process.exitCode = 0;
  vi.restoreAllMocks();
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/mcp";
}

function textResult(value: unknown): object {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

describe("control-plane MCP client", () => {
  it("accepts HTTPS and local HTTP but rejects remote plaintext transport", () => {
    expect(validateMcpUrl("https://aceteam.ai/mcp")).toBe("https://aceteam.ai/mcp");
    expect(validateMcpUrl("http://127.0.0.1:3000/mcp")).toBe("http://127.0.0.1:3000/mcp");
    expect(validateMcpUrl("http://[::1]:3000/mcp")).toBe("http://[::1]:3000/mcp");
    expect(() => validateMcpUrl("http://remote.example/mcp")).toThrow(CliError);
    expect(() => validateMcpUrl("not a url")).toThrow(CliError);
    expect(() => new ControlPlaneClient({
      kind: "api_key",
      mcp_url: "http://remote.example/mcp",
      access_token: "secret",
    })).toThrow(CliError);
  });

  it("unwraps AceTeam's acting-org result envelope for machine JSON", () => {
    expect(unwrapToolResult({
      structuredContent: {
        acting_org_id: "org-a",
        result: '{"user_id":"user-1","organization_id":"org-a"}',
      },
    })).toEqual({ user_id: "user-1", organization_id: "org-a" });
  });

  it("initializes once, echoes its session, discovers live schemas, and switches org before calls", async () => {
    const seen: Array<{ method: string; name?: string; session?: string; args?: unknown }> = [];
    let activeOrg = "org-a";
    const tools: McpTool[] = [
      { name: "whoami", inputSchema: { type: "object", properties: {} } },
      { name: "switch_active_org", inputSchema: { type: "object", required: ["organization_id"], properties: { organization_id: { type: "string" } } } },
      { name: "forge_pr_list", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" } } } },
    ];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown>; cursor?: string };
      };
      seen.push({
        method: payload.method,
        name: payload.params?.name,
        session: request.headers["mcp-session-id"] as string | undefined,
        args: payload.params?.arguments,
      });
      response.setHeader("Mcp-Session-Id", "session-123");
      if (payload.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (payload.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "test", version: "1" } };
      if (payload.method === "tools/list") result = payload.params?.cursor ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "page-2" };
      if (payload.method === "tools/call") {
        if (payload.params?.name === "whoami") result = textResult({ user_id: "user-1", organization_id: activeOrg });
        if (payload.params?.name === "switch_active_org") {
          activeOrg = String(payload.params.arguments?.organization_id);
          result = textResult({ organization_id: activeOrg });
        }
        if (payload.params?.name === "forge_pr_list") result = textResult({ pulls: [1, 2] });
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    });
    const url = await listen(server);
    const client = new ControlPlaneClient(
      { kind: "oauth", mcp_url: url, access_token: "test-token", active_org_id: "org-b" },
      fetch,
      vi.fn(),
    );

    expect((await client.ensureSelectedOrg()).organization_id).toBe("org-b");
    const schema = await client.getTool("forge_pr_list");
    expect(schema.name).toBe("forge_pr_list");
    validateToolArgs(schema, { owner: "aceteam-ai", repo: "aceteam" });
    expect(() => validateToolArgs(schema, { owner: "aceteam-ai" })).toThrow(CliError);
    const result = await client.callTool("forge_pr_list", { owner: "aceteam-ai", repo: "aceteam" });
    expect(unwrapToolResult(result)).toEqual({ pulls: [1, 2] });
    expect(seen.filter((entry) => entry.method === "initialize")).toHaveLength(1);
    expect(seen.filter((entry) => entry.method === "tools/list")).toHaveLength(2);
    expect(seen.find((entry) => entry.name === "forge_pr_list")?.session).toBe("session-123");
    expect(seen.map((entry) => entry.name).filter(Boolean)).toEqual([
      "whoami",
      "switch_active_org",
      "whoami",
      "forge_pr_list",
    ]);
  });

  it("rejects a failed MCP tool call and does not treat it as successful JSON", async () => {
    const responses = [
      new Response(JSON.stringify({ result: { protocolVersion: "2025-06-18" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(null, { status: 202 }),
      new Response(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "denied" }] } }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ];
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responses.shift()!);
    const client = new ControlPlaneClient(
      { kind: "api_key", mcp_url: "https://aceteam.ai/mcp", access_token: "test" },
      fakeFetch as unknown as typeof fetch,
    );
    await expect(client.callTool("forge_pr_list")).rejects.toMatchObject({ exitCode: 4, message: "denied" });
    expect(fakeFetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("fails closed if a single-org API key acts in a different org than its saved context", async () => {
    const responses = [
      new Response(JSON.stringify({ result: { protocolVersion: "2025-06-18" } }), { status: 200, headers: { "Content-Type": "application/json" } }),
      new Response(null, { status: 202 }),
      new Response(JSON.stringify({ result: textResult({ organization_id: "org-b" }) }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ];
    const fakeFetch = vi.fn(async () => responses.shift()!);
    const client = new ControlPlaneClient(
      { kind: "api_key", mcp_url: "https://aceteam.ai/mcp", access_token: "test", active_org_id: "org-a" },
      fakeFetch as unknown as typeof fetch,
    );
    await expect(client.ensureSelectedOrg()).rejects.toMatchObject({
      exitCode: 3,
      message: "API-key organization changed. Run ace login again.",
    });
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes OAuth credentials and restores the persisted org context", async () => {
    let activeOrg = "org-a";
    const methods: string[] = [];
    const persisted = vi.fn();
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/oauth/token")) {
        return new Response(JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }), { status: 200 });
      }
      const payload = JSON.parse(String(init?.body)) as { method: string; id?: number; params?: { name?: string; arguments?: { organization_id?: string } } };
      methods.push(payload.method + (payload.params?.name ? ":" + payload.params.name : ""));
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown = { protocolVersion: "2025-06-18" };
      if (payload.params?.name === "whoami") result = textResult({ organization_id: activeOrg });
      if (payload.params?.name === "switch_active_org") {
        activeOrg = String(payload.params.arguments?.organization_id);
        result = textResult({ organization_id: activeOrg });
      }
      return new Response(JSON.stringify({ id: payload.id, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new ControlPlaneClient(
      {
        kind: "oauth",
        mcp_url: "https://aceteam.ai/mcp",
        access_token: "expired",
        refresh_token: "old-refresh",
        client_id: "client-1",
        expires_at: Date.now() - 1000,
        active_org_id: "org-b",
      },
      fakeFetch as unknown as typeof fetch,
      persisted,
    );

    expect((await client.ensureSelectedOrg()).organization_id).toBe("org-b");
    expect(persisted).toHaveBeenCalledWith(expect.objectContaining({
      access_token: "new-access",
      refresh_token: "new-refresh",
      active_org_id: "org-b",
    }));
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call:whoami",
      "tools/call:switch_active_org",
      "tools/call:whoami",
    ]);
  });
});

describe("browser OAuth and CLI argument contract", () => {
  it("uses registered localhost PKCE, verifies callback state, and exchanges the code", async () => {
    let authorizationUrl = "";
    let tokenBody = "";
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/oauth/register") {
        const body = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
        expect(body.redirect_uris[0]).toMatch(/^http:\/\/localhost:\d+\/callback$/);
        return new Response(JSON.stringify({ client_id: "client-1" }), { status: 201 });
      }
      if (url.pathname === "/api/oauth/token") {
        tokenBody = String(init?.body);
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), { status: 200 });
      }
      throw new Error("Unexpected request");
    });
    const session = await browserLogin(
      "https://aceteam.ai/mcp",
      (url) => {
        authorizationUrl = url;
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        callback.searchParams.set("code", "code-1");
        void fetch(callback);
      },
      fakeFetch as unknown as typeof fetch,
      5000,
    );
    expect(session).toMatchObject({ kind: "oauth", client_id: "client-1", access_token: "access", refresh_token: "refresh" });
    expect(new URL(authorizationUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(tokenBody).toContain("code_verifier=");
    expect(tokenBody).toContain("resource=https%3A%2F%2Faceteam.ai%2Fmcp");
    expect(fakeFetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it("rejects a browser callback with the wrong OAuth state", async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ client_id: "client-1" }), { status: 201 }),
    );
    await expect(browserLogin(
      "https://aceteam.ai/mcp",
      (url) => {
        const callback = new URL(new URL(url).searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", "wrong");
        callback.searchParams.set("code", "code-1");
        void fetch(callback);
      },
      fakeFetch as unknown as typeof fetch,
      5000,
    )).rejects.toMatchObject({ exitCode: 3, message: "OAuth state mismatch. Run ace login again." });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("parses JSON and key=value arguments and gives errors stable exit codes", async () => {
    expect(parseToolArgs('{"owner":"aceteam-ai"}', ["repo=aceteam", "limit=3"])).toEqual({
      owner: "aceteam-ai",
      repo: "aceteam",
      limit: 3,
    });
    expect(() => parseToolArgs("[]", [])).toThrow(CliError);
    expect(() => parseToolArgs(undefined, ["broken"])).toThrow(CliError);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runCli(async () => { throw new CliError(2, "Invalid arguments"); }, { json: true, quiet: false });
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toEqual({ error: { code: 2, message: "Invalid arguments" } });
  });
});
