import { describe, expect, it, vi } from "vitest";
import { normalizePlatformOrigin } from "../../src/platform/config.js";
import { createPlatformClientFromConfig } from "../../src/platform/client.js";
import type { ControlPlaneSession } from "../../src/utils/config.js";

const API_KEY_SESSION: ControlPlaneSession = {
  kind: "api_key",
  mcp_url: "https://example.com/mcp",
  access_token: "synthetic-key",
  active_org_id: "org-a",
};

describe("platform origin validation", () => {
  it("accepts HTTPS origins and explicit loopback HTTP only", () => {
    expect(normalizePlatformOrigin("https://EXAMPLE.com:443/")).toBe("https://example.com");
    expect(normalizePlatformOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(() => normalizePlatformOrigin("http://example.com")).toThrow("HTTPS");
  });

  it.each([
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?org=x",
    "https://example.com/#fragment",
  ])("rejects non-origin URL configuration: %s", (value) => {
    expect(() => normalizePlatformOrigin(value)).toThrow("origin");
  });
});

describe("shared control-plane session", () => {
  it("uses the selected API-key session and verified organization for REST", async () => {
    const ensureSelectedOrg = vi.fn(async () => ({ organization_id: "org-a" }));
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe("https://example.com/api/workflow-templates");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-key" });
      return Response.json({ templates: [] });
    });
    const client = await createPlatformClientFromConfig({ session: API_KEY_SESSION, controlPlane: { ensureSelectedOrg }, fetch: fetch as typeof globalThis.fetch });
    await expect(client.listTemplates()).resolves.toEqual([]);
    expect(ensureSelectedOrg).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses an API-key session whose active organization cannot be verified", async () => {
    const ensureSelectedOrg = vi.fn(async () => ({ organization_id: "org-b" }));
    const fetch = vi.fn();
    await expect(createPlatformClientFromConfig({ session: API_KEY_SESSION, controlPlane: { ensureSelectedOrg }, fetch })).rejects.toMatchObject({ exitCode: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses OAuth-only REST access with actionable exit 2 before a network request", async () => {
    const ensureSelectedOrg = vi.fn();
    const fetch = vi.fn();
    await expect(createPlatformClientFromConfig({
      session: { ...API_KEY_SESSION, kind: "oauth" }, controlPlane: { ensureSelectedOrg }, fetch,
    })).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining("ace login --api-key-env") });
    expect(ensureSelectedOrg).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
