import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type ControlPlaneSession } from "./config.js";
import { CliError, DEFAULT_MCP_URL } from "./control-plane.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(4, "The control plane returned an invalid OAuth response.");
  }
  return value as Record<string, unknown>;
}

async function jsonPost(
  fetchImpl: typeof fetch,
  url: URL,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(4, "Could not reach the control plane.");
  }
  if (!response.ok) throw new CliError(4, "OAuth request failed (HTTP " + response.status + ").");
  return record(await response.json());
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

export async function browserLogin(
  mcpUrl = DEFAULT_MCP_URL,
  announce: (url: string) => void = (url) => console.error("Open " + url),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 300_000,
): Promise<ControlPlaneSession> {
  const mcp = new URL(mcpUrl);
  if (mcp.protocol !== "https:" && mcp.hostname !== "localhost") {
    throw new CliError(2, "Control-plane URL must use HTTPS.");
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  let finish!: (code: string) => void;
  let fail!: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400).end("Invalid state. Return to Ace and retry.");
      fail(new CliError(3, "OAuth state mismatch. Run ace login again."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400).end("Authorization was not completed.");
      fail(new CliError(3, "Authorization was not completed."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Ace is connected. You can return to the terminal.");
    finish(code);
  });
  const port = await listen(server);
  const redirectUri = "http://localhost:" + port + "/callback";
  const timer = setTimeout(() => fail(new CliError(3, "Login timed out. Run ace login again.")), timeoutMs);
  try {
    const registration = await jsonPost(
      fetchImpl,
      new URL("/api/oauth/register", mcp),
      {
        redirect_uris: [redirectUri],
        client_name: "Ace CLI",
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      },
    );
    if (typeof registration.client_id !== "string") {
      throw new CliError(4, "The control plane returned no OAuth client ID.");
    }
    const authorization = new URL("/api/oauth/authorize", mcp);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "mcp:read mcp:write",
      resource: mcp.toString(),
    }).toString();
    announce(authorization.toString());
    const code = await callback;
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: registration.client_id,
      code_verifier: verifier,
      resource: mcp.toString(),
    });
    let response: Response;
    try {
      response = await fetchImpl(new URL("/api/oauth/token", mcp), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
    } catch {
      throw new CliError(4, "Could not reach the control plane.");
    }
    if (!response.ok) throw new CliError(3, "OAuth token exchange failed.");
    const token = record(await response.json());
    if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string") {
      throw new CliError(4, "The control plane returned an invalid token response.");
    }
    return {
      kind: "oauth",
      mcp_url: mcp.toString(),
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      client_id: registration.client_id,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000,
    };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
